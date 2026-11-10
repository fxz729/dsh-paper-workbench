#!/usr/bin/env python
"""babeldoc 驱动（dsh-paper-reader 专用）：进度事件 + 去掉单次请求的输出长度上限。

用法与 babeldoc 完全一致——argv 原样交给 babeldoc 的 CLI 解析：

    python babeldoc-driver.py --files a.pdf --lang-in en --lang-out zh-CN --openai ...

运行时补丁包含进度、完整回复恢复、已验证端点推理参数及 HTTP 限流指标。
初始化失败会明确报错，不静默退回未限流或可能截断的路径：

1. 进度：把 babeldoc 的 ProgressMonitor 事件按行写到 stdout，前缀 `@@DPR@@`，
   内容是一行 JSON（Node 侧逐行解析）。babeldoc 自己的 logger 被它自己设成
   ERROR 级并摘掉 handler，所以只能这么传。
2. 长度：babeldoc 调 LLM 时不传 max_tokens（端点默认值常常只有 2k~4k，
   长段落的中文译文会被静默截断），这里显式给足；万一仍被截断
   （finish_reason=length）或端点直接报「输入太长」，就把输入按换行/句子
   拆成小段分别翻译再拼回，避免整段丢译文或整篇失败。

环境变量（都可选）：
  DPR_MAX_OUTPUT_TOKENS  单次请求的 max_tokens 上限，默认 8192；0 = 不传该参数
  DPR_SPLIT_TOKENS       触发拆分的输入上限（估算 token），默认 3000
  DPR_DEBUG=1            额外把补丁动作打到 stderr
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import time
import threading
from urllib.parse import urlsplit

import httpx

PREFIX = "@@DPR@@"
_START_TIME = time.monotonic()
_METRIC_LOCK = threading.Lock()
_HTTP_ROWS = []


def _reconfigure_streams() -> None:
    """Windows 控制台默认 GBK，中文事件会乱码或被丢弃，改成 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


_STDOUT_LOCK = None


def emit(payload: dict) -> None:
    """翻译在线程池里跑，多线程写 stdout 会撕行，加锁保证一行一条。"""
    global _STDOUT_LOCK
    if _STDOUT_LOCK is None:
        import threading

        _STDOUT_LOCK = threading.Lock()
    try:
        payload = {**payload, "elapsedSeconds": round(time.monotonic() - _START_TIME, 6)}
        line = PREFIX + " " + json.dumps(payload, ensure_ascii=False) + "\n"
        with _STDOUT_LOCK:
            sys.stdout.write(line)
            sys.stdout.flush()
    except Exception:
        pass


def note(message: str) -> None:
    try:
        sys.stderr.write(f"[dpr] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


MAX_OUT = _env_int("DPR_MAX_OUTPUT_TOKENS", 8192)
SPLIT_TOKENS = max(200, _env_int("DPR_SPLIT_TOKENS", 3000))
DEBUG = os.environ.get("DPR_DEBUG", "") not in ("", "0", "false", "False")
REPORT_MIN_INTERVAL = 0.35  # 进度事件最小间隔（秒），别把 stdout 刷爆


# --------------------------------------------------------------------------
# 补丁 1：进度事件
# --------------------------------------------------------------------------
def install_progress() -> None:
    import babeldoc.main as bmain

    last = [0.0]
    started = {}

    def handle(event: dict) -> None:
        kind = event.get("type")
        if kind == "stage_summary":
            stages = [
                {"name": (s or {}).get("name"), "weight": (s or {}).get("percent")}
                for s in (event.get("stages") or [])
            ]
            emit({"kind": "stages", "stages": stages})
            return
        now = time.monotonic()
        stage_key = (event.get("part_index"), event.get("stage"))
        if kind == "progress_start":
            started[stage_key] = now
        duration = now - started[stage_key] if kind == "progress_end" and stage_key in started else None
        if kind == "progress_update" and now - last[0] < REPORT_MIN_INTERVAL:
            return
        last[0] = now
        emit(
            {
                "kind": "progress",
                "type": kind,
                "stage": event.get("stage"),
                "durationSeconds": round(duration, 6) if duration is not None else None,
                "stageCurrent": event.get("stage_current"),
                "stageTotal": event.get("stage_total"),
                "stagePercent": event.get("stage_progress"),
                "overall": event.get("overall_progress"),
                "part": event.get("part_index"),
                "totalParts": event.get("total_parts"),
            }
        )

    def create_progress_handler(config, show_log=False):  # noqa: ARG001
        return contextlib.nullcontext(), handle

    bmain.create_progress_handler = create_progress_handler
    if DEBUG:
        note("progress handler installed")


# --------------------------------------------------------------------------
# 补丁 2：不再让单次请求「长度受限」
# --------------------------------------------------------------------------
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_PARAM_ERROR_RE = re.compile(r"max_(completion_)?tokens|unrecognized|unknown (parameter|field)|invalid_request", re.I)
_TOO_LONG_RE = re.compile(
    r"too long|context length|maximum context|max.*tokens.*exceed|prompt is too|"
    r"input.*(length|size).*(limit|exceed)|超过.*(长度|上限)|过长|too many tokens",
    re.I,
)
_THINKING_RE = re.compile(r"始终思考|不支持关闭思考|thinking|推理", re.I)


def rough_tokens(text: str) -> int:
    """粗估 token：英文约 4 字符 1 token，CJK 约 1.5 字符 1 token。"""
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    latin = len(text) - cjk
    return int(latin / 4 + cjk / 1.5) + 1


_TAG_RE = re.compile(r"<\s*(/?)\s*(style|b\d+)\b[^>]*>", re.I)
_ATOM_RE = re.compile(r"<[^>]+>|\{[^{}]*\}|\s+|[^<{}\s]+|.", re.S)


def placeholders_balanced(text: str) -> bool:
    """支持 BabelDOC 的 style 与 b 标签，禁止在富文本跨度中间拆分。"""
    stack = []
    for match in _TAG_RE.finditer(text):
        closing, tag = match.group(1), match.group(2).lower()
        if closing:
            if not stack or stack.pop() != tag:
                return False
        else:
            stack.append(tag)
    return not stack


def split_text(text: str, limit_tokens: int) -> tuple[list[str], str]:
    """源片段逐字拼回等于输入；标签与公式占位符不可截断。"""
    if rough_tokens(text) <= limit_tokens or not placeholders_balanced(text):
        return [text], ""
    pieces, stack, start = [], [], 0
    for match in _ATOM_RE.finditer(text):
        if not stack and match.start() > start and rough_tokens(text[start:match.end()]) > limit_tokens:
            pieces.append(text[start:match.start()])
            start = match.start()
        tag = _TAG_RE.fullmatch(match.group())
        if tag:
            if tag.group(1):
                stack.pop()
            else:
                stack.append(tag.group(2).lower())
    if start < len(text):
        pieces.append(text[start:])
    return (pieces, "\n") if len(pieces) > 1 else ([text], "")


class IncompleteTranslationError(RuntimeError):
    """回复为空、截断或结构不完整，不能当作成功译文。"""


def structured_input(text):
    marker = "## Here is the input:"
    if marker not in text:
        return None
    head, tail = text.rsplit(marker, 1)
    try:
        items = json.loads(tail)
    except ValueError:
        return None
    if not isinstance(items, list) or not items or not all(isinstance(x, dict) and "id" in x and isinstance(x.get("input"), str) for x in items):
        return None
    return head + marker + "\n\n", items


def validate_llm_reply(text, output):
    source = structured_input(text)
    if source is None:
        if not output.strip():
            raise IncompleteTranslationError("empty translation response")
        return None
    try:
        parsed = json.loads(output)
    except (ValueError, TypeError) as exc:
        raise IncompleteTranslationError("incomplete translation JSON") from exc
    items = source[1]
    if not isinstance(parsed, list) or len(parsed) != len(items):
        raise IncompleteTranslationError("translation item count mismatch")
    for original, translated in zip(items, parsed):
        if not isinstance(translated, dict) or translated.get("id") != original["id"] or not isinstance(translated.get("output"), str) or (original["input"].strip() and not translated["output"].strip()):
            raise IncompleteTranslationError("translation ID or content missing")
    return parsed


def reasoning_effort_for(base_url, model, *, reasoning=None, thinking=None):
    """仅对已经验证的精确端点/模型启用；显式调用者选择优先。"""
    if reasoning is not None or thinking is not None:
        return None
    if urlsplit(str(base_url)).hostname == "api.heykong729.com" and model == "deepseek-flash":
        return "none"
    return None


class RequestLimiter:
    """把 BabelDOC 限流从段落入口移到实际 HTTP 发送，避免重复限速。"""
    def __init__(self, original):
        self.original = original

    def wait(self, *args, **kwargs):
        pass

    def set_max_qps(self, value):
        self.original.set_max_qps(value)
        emit({"kind": "runtime_limits", "qps": value, "scope": "http_attempt"})

    def request_wait(self):
        self.original.wait()

    def defer(self, seconds):
        with self.original.lock:
            self.original.next_request_time = max(self.original.next_request_time, time.monotonic() + seconds)


class MeasuredTransport(httpx.BaseTransport):
    """仅记录耗时、状态和数值用量；绝不输出正文、URL、header 或异常消息。"""
    def __init__(self, inner, limiter):
        self.inner, self.limiter = inner, limiter

    def handle_request(self, request):
        waiting = time.monotonic()
        self.limiter.request_wait()
        start = time.monotonic()
        row = {"kind": "http_attempt", "waitSeconds": round(start - waiting, 6)}
        try:
            response = self.inner.handle_request(request)
            response.read()
            row["status"] = response.status_code
            if response.status_code == 429:
                try:
                    pause = min(60, max(1, float(response.headers.get("Retry-After", "1"))))
                except ValueError:
                    pause = 1
                self.limiter.defer(pause)
            try:
                body = response.json()
                usage = body.get("usage") or {}
                details = usage.get("completion_tokens_details") or {}
                for key, value in (("promptTokens", usage.get("prompt_tokens")), ("completionTokens", usage.get("completion_tokens")), ("reasoningTokens", details.get("reasoning_tokens"))):
                    row[key] = value if isinstance(value, int) and not isinstance(value, bool) else None
                reason = (body.get("choices") or [{}])[0].get("finish_reason")
                row["finishReason"] = reason if reason in ("stop", "length", "content_filter", "tool_calls") else None
            except (ValueError, TypeError, AttributeError, IndexError):
                pass
            return response
        except Exception as exc:
            row["errorType"] = type(exc).__name__
            raise
        finally:
            row["seconds"] = round(time.monotonic() - start, 6)
            with _METRIC_LOCK:
                row["attempt"] = len(_HTTP_ROWS) + 1
                _HTTP_ROWS.append(row)
            emit(row)

    def close(self):
        self.inner.close()


def install_translation() -> dict:
    import openai
    from tenacity import retry
    from tenacity import retry_if_exception_type
    from tenacity import stop_after_attempt
    from tenacity import wait_exponential

    import babeldoc.translator.translator as translator_module
    from babeldoc.translator.translator import OpenAITranslator

    limiter = translator_module._translate_rate_limiter
    if not hasattr(limiter, "request_wait"):
        limiter = RequestLimiter(limiter)
        translator_module._translate_rate_limiter = limiter
    original_init = OpenAITranslator.__init__

    def init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        client = self.client._client
        if not getattr(client, "_dpr_measured", False):
            client._transport = MeasuredTransport(client._transport, limiter)
            client._mounts = {key: MeasuredTransport(value, limiter) if value is not None else None for key, value in client._mounts.items()}
            client._dpr_measured = True
        # 避免 SDK 的重试乘上外层重试；每次实际发送仍由 transport 计数/限流。
        self.client.max_retries = 0
        effort = reasoning_effort_for(self.client.base_url, self.model, reasoning=getattr(self, "reasoning", None), thinking=getattr(self, "thinking", None))
        if effort:
            self.add_cache_impact_parameters("reasoning_effort", effort)
        # 修复恢复协议后不复用可能含空/截断译文的旧缓存。
        self.add_cache_impact_parameters("dpr-response-contract", "complete-json-v2")
        emit({"kind": "translator", "reasoningEffort": effort, "sdkRetries": 0, "retryAttempts": 4})

    OpenAITranslator.__init__ = init
    stats = {"splits": 0, "truncated": 0, "param_fallback": 0, "thinking_fallback": 0, "invalid_responses": 0}

    def budget_for(text: str) -> int:
        """给一次请求配的 max_tokens：中文译文约为英文原文的 2.5~3 倍 token。"""
        if MAX_OUT <= 0:
            return 0
        return min(MAX_OUT, max(2048, int(rough_tokens(text) * 2.6) + 256))

    def raw_request(self, text, budget, llm_mode, rate_limit_params):
        options = {}
        if getattr(self, "send_temperature", True):
            options.update(self.options)
        params = rate_limit_params or {}
        if (
            llm_mode
            and getattr(self, "enable_json_mode_if_requested", False)
            and params.get("request_json_mode", False)
        ):
            options["response_format"] = {"type": "json_object"}
        extra_headers = {}
        if getattr(self, "send_dashscope_header", False):
            extra_headers["X-DashScope-DataInspection"] = (
                '{"input": "disable", "output": "disable"}'
            )
        extra_body = dict(getattr(self, "extra_body", {}) or {})
        if getattr(self, "_dpr_drop_thinking", False):
            # 端点明确拒绝 thinking 开关（如常思考模型）时彻底不提这个字段
            extra_body.pop("thinking", None)
            extra_body.pop("reasoning", None)
        # babeldoc 的 LLM 模式自己带完整提示词（[role]/[glossary] 模板），普通模式用 prompt()
        messages = [{"role": "user", "content": text}] if llm_mode else self.prompt(text)
        kwargs = {"model": self.model, **options, "messages": messages, "extra_body": extra_body}
        effort = reasoning_effort_for(getattr(self.client, "base_url", ""), self.model, reasoning=getattr(self, "reasoning", None), thinking=getattr(self, "thinking", None))
        if effort:
            kwargs["reasoning_effort"] = effort
        elif getattr(self, "_dpr_low_reasoning", False):
            kwargs["reasoning_effort"] = "low"
        if extra_headers:
            kwargs["extra_headers"] = extra_headers
        if budget and not getattr(self, "_dpr_no_max_tokens", False):
            kwargs["max_tokens"] = int(budget)
        response = self.client.chat.completions.create(**kwargs)
        self.update_token_count(response)
        choice = response.choices[0]
        return (choice.message.content or "").strip(), choice.finish_reason

    def call(self, text, budget, llm_mode, rate_limit_params):
        """一次请求；端点拒绝 thinking 开关时去掉该字段重试（只做一次）。"""
        try:
            return raw_request(self, text, budget, llm_mode, rate_limit_params)
        except openai.BadRequestError as exc:
            message = str(exc)
            if _THINKING_RE.search(message) and not getattr(self, "_dpr_drop_thinking", False):
                self.__dict__["_dpr_drop_thinking"] = True
                self.__dict__["_dpr_low_reasoning"] = True
                stats["thinking_fallback"] += 1
                note("endpoint refuses thinking=disabled, retrying without the field + reasoning_effort=low")
                return raw_request(self, text, budget, llm_mode, rate_limit_params)
            raise

    @retry(
        retry=retry_if_exception_type((openai.RateLimitError, openai.APIConnectionError, openai.InternalServerError)),
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=1, max=15),
        before_sleep=lambda state: emit({"kind": "retry", "attempt": state.attempt_number, "sleepSeconds": state.next_action.sleep, "errorType": type(state.outcome.exception()).__name__}),
    )
    def send(self, text, budget, llm_mode, rate_limit_params):
        return call(self, text, budget, llm_mode, rate_limit_params)

    def split_translate(self, text, llm_mode, rate_limit_params, depth=0):
        """拆 JSON 数据而非提示词，逐项合并；不能安全恢复时明确报错。"""
        if depth >= 6:
            raise IncompleteTranslationError("translation recovery depth exceeded")
        structured = structured_input(text) if llm_mode else None
        if llm_mode and structured is None:
            raise IncompleteTranslationError("unknown structured prompt cannot be split safely")
        stats["splits"] += 1
        if structured:
            prefix, items = structured
            if len(items) > 1:
                midpoint = len(items) // 2
                merged = []
                for batch in (items[:midpoint], items[midpoint:]):
                    request = prefix + json.dumps(batch, ensure_ascii=False)
                    result = run(self, request, True, rate_limit_params, depth + 1)
                    merged.extend(validate_llm_reply(request, result))
                return json.dumps(merged, ensure_ascii=False)
            item = items[0]
            body = item["input"]
        else:
            body = text
        limit = max(100, min(SPLIT_TOKENS, rough_tokens(body) // 2))
        pieces, joiner = split_text(body, limit)
        if len(pieces) <= 1 or any(not p.strip() for p in pieces):
            raise IncompleteTranslationError("incomplete response cannot be recovered without breaking source boundaries")
        emit({"kind": "split", "pieces": len(pieces), "depth": depth, "structured": bool(structured)})
        outputs = []
        for piece in pieces:
            if structured:
                fragment = {**item, "input": piece}
                request = prefix + json.dumps([fragment], ensure_ascii=False)
                result = run(self, request, True, rate_limit_params, depth + 1)
                outputs.append(validate_llm_reply(request, result)[0]["output"])
            else:
                outputs.append(run(self, piece, False, rate_limit_params, depth + 1))
        output = joiner.join(outputs)
        return json.dumps([{"id": item["id"], "output": output}], ensure_ascii=False) if structured else output

    def run(self, text, llm_mode, rate_limit_params, depth=0):
        if not isinstance(text, str) or not text.strip():
            return ""
        structured = structured_input(text) if llm_mode else None
        if structured and depth < 6:
            items = structured[1]
            if len(items) > 1 and sum(rough_tokens(i["input"]) for i in items) > SPLIT_TOKENS:
                return split_translate(self, text, llm_mode, rate_limit_params, depth)
            if len(items) == 1 and rough_tokens(items[0]["input"]) > SPLIT_TOKENS and len(split_text(items[0]["input"], SPLIT_TOKENS)[0]) > 1:
                return split_translate(self, text, llm_mode, rate_limit_params, depth)
        budget = budget_for(text)
        try:
            out, reason = send(self, text, budget, llm_mode, rate_limit_params)
        except openai.BadRequestError as exc:
            message = str(exc)
            if _TOO_LONG_RE.search(message):
                return split_translate(self, text, llm_mode, rate_limit_params, depth)
            if _PARAM_ERROR_RE.search(message) and not getattr(self, "_dpr_no_max_tokens", False):
                self.__dict__["_dpr_no_max_tokens"] = True
                stats["param_fallback"] += 1
                note("endpoint rejected max_tokens, retrying without it")
                out, reason = send(self, text, 0, llm_mode, rate_limit_params)
            else:
                raise
        if reason == "length" or not out.strip():
            stats["truncated"] += int(reason == "length")
            emit({"kind": "recovery", "reason": "length" if reason == "length" else "empty", "depth": depth})
            if budget < MAX_OUT:
                out, reason = send(self, text, MAX_OUT, llm_mode, rate_limit_params)
            if reason == "length" or not out.strip():
                return split_translate(self, text, llm_mode, rate_limit_params, depth)
        if reason == "content_filter":
            raise IncompleteTranslationError("provider refused translation content")
        if llm_mode:
            try:
                validate_llm_reply(text, out)
            except IncompleteTranslationError:
                stats["invalid_responses"] += 1
                emit({"kind": "recovery", "reason": "invalid_json", "depth": depth})
                return split_translate(self, text, llm_mode, rate_limit_params, depth)
        return out

    def do_translate(self, text, rate_limit_params=None):
        return run(self, text, False, rate_limit_params)

    def do_llm_translate(self, text, rate_limit_params=None):
        # babeldoc 0.6.4 的段落翻译走这条：原实现把 max_tokens 硬写成 2048
        return run(self, text, True, rate_limit_params)

    OpenAITranslator.do_translate = do_translate
    OpenAITranslator.do_llm_translate = do_llm_translate
    if DEBUG:
        note(f"translation patch installed (max_out={MAX_OUT}, split={SPLIT_TOKENS})")
    return stats


def normalize_no_proxy() -> None:
    """httpx 0.28 将 NO_PROXY 中的 [::1] 误作通配主机；仅规范化裸 IPv6。

    只影响当前翻译子进程，保留代理、域名、端口及其他绕过规则。
    """
    from ipaddress import IPv6Address

    for name in ("NO_PROXY", "no_proxy"):
        raw = os.environ.get(name)
        if raw is None:
            continue
        hosts = raw.split(",")
        changed = False
        for index, host in enumerate(hosts):
            value = host.strip()
            if value.startswith("[") and value.endswith("]"):
                try:
                    IPv6Address(value[1:-1])
                except ValueError:
                    continue
                hosts[index] = value[1:-1]
                changed = True
        if changed:
            os.environ[name] = ",".join(hosts)


def emit_http_summary():
    with _METRIC_LOCK:
        rows = list(_HTTP_ROWS)
    durations = sorted(r["seconds"] for r in rows)
    emit({
        "kind": "http_summary", "attempts": len(rows),
        "http429": sum(r.get("status") == 429 for r in rows),
        "http5xx": sum(500 <= r.get("status", 0) < 600 for r in rows),
        "networkErrors": sum("errorType" in r for r in rows),
        "lengthResponses": sum(r.get("finishReason") == "length" for r in rows),
        "promptTokens": sum(r.get("promptTokens") or 0 for r in rows),
        "completionTokens": sum(r.get("completionTokens") or 0 for r in rows),
        "reasoningTokensKnown": sum(r.get("reasoningTokens") or 0 for r in rows),
        "reasoningUsageMissing": sum(r.get("reasoningTokens") is None for r in rows),
        "p50Seconds": durations[len(durations) // 2] if durations else None,
        "p95Seconds": durations[min(len(durations) - 1, int(len(durations) * .95))] if durations else None,
        "maxSeconds": durations[-1] if durations else None,
    })


def audit_tracking(args):
    """BabelDOC 内部可能回退到原文；输出为空时不得向宿主报告完整成功。"""
    from pathlib import Path

    count, empty, files = 0, 0, 0
    def visit(value):
        nonlocal count, empty
        if isinstance(value, dict):
            if all(k in value for k in ("input", "output", "pdf_unicode")):
                count += 1
                empty += bool(value["input"].strip()) and not bool(value["output"].strip())
            else:
                for child in value.values():
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    if args.working_dir:
        for source in args.files or []:
            path = Path(args.working_dir) / Path(source).stem / "translate_tracking.json"
            if path.is_file():
                visit(json.loads(path.read_text(encoding="utf-8")))
                files += 1
    emit({"kind": "translation_audit", "files": files, "trackedParagraphs": count, "emptyOutputs": empty})
    return empty


def main() -> int:
    normalize_no_proxy()
    _reconfigure_streams()
    emit({"kind": "driver", "version": 2, "maxOutputTokens": MAX_OUT, "splitTokens": SPLIT_TOKENS})
    import asyncio

    try:
        install_progress()
        stats = install_translation()
    except Exception as exc:
        emit({"kind": "exit", "code": 1, "error": "translation runtime setup failed", "errorType": type(exc).__name__})
        return 1

    import babeldoc.main as bmain

    try:
        args = bmain.create_parser().parse_args()
        emit({"kind": "runtime_config", "qps": args.qps, "workers": args.pool_max_workers or args.qps})
        asyncio.run(bmain.main())
        empty = audit_tracking(args)
        emit({"kind": "recovery_summary", **stats})
        if empty:
            emit({"kind": "exit", "code": 1, "error": "translation incomplete: empty paragraph outputs remain", "emptyOutputs": empty})
            return 1
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        emit({"kind": "exit", "code": code})
        return code
    except BaseException as exc:
        # 上游错误正文可能回显鉴权信息；只保留类型，HTTP 状态/用量由独立事件说明。
        emit({"kind": "exit", "code": 1, "error": "BabelDOC failed", "errorType": type(exc).__name__})
        return 1
    finally:
        emit_http_summary()
    emit({"kind": "exit", "code": 0})
    return 0


if __name__ == "__main__":
    sys.exit(main())
