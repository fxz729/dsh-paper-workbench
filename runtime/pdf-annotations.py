"""Native PDF annotations. Input geometry is unrotated PDF user space, not pixels."""
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import pymupdf as fitz

PREFIX = 'dpr:v1:'
TYPES = {'highlight', 'underline', 'rectangle', 'ellipse', 'line', 'arrow', 'ink', 'marker', 'note', 'freetext'}


def version(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def owned(annot):
    info = annot.info
    if not info.get('id', '').startswith('dpr-') or not info.get('subject', '').startswith(PREFIX):
        return None
    try:
        item = json.loads(info['subject'][len(PREFIX):])
        item['id'] = info['id']
        item['note'] = info.get('content', '')
        return item
    except (ValueError, TypeError):
        return None


def read_items(doc):
    items = []
    for page in doc:
        for annot in page.annots() or []:
            item = owned(annot)
            if item:
                item['page'] = page.number + 1
                items.append(item)
    return items


def validate(item, doc):
    if not isinstance(item, dict) or not re.fullmatch(r'dpr-[A-Za-z0-9-]{1,80}', str(item.get('id', ''))):
        raise ValueError('invalid annotation id')
    kind = item.get('type')
    page = item.get('page')
    if kind not in TYPES or type(page) is not int or not 1 <= page <= len(doc):
        raise ValueError('invalid annotation page or type')
    color = item.get('color', '#ffcc00')
    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError('invalid annotation color')
    note = item.get('note', '')
    if not isinstance(note, str) or len(note) > 10000:
        raise ValueError('invalid annotation note')
    def number(v):
        return type(v) in (int, float) and math.isfinite(v) and abs(v) < 1000000
    width, opacity = item.get('width', 2), item.get('opacity', 0.5)
    if not number(width) or not .1 <= width <= 30 or not number(opacity) or not 0 <= opacity <= 1:
        raise ValueError('invalid annotation style')
    rects, points = item.get('rects', []), item.get('points', [])
    if not isinstance(rects, list) or not 1 <= len(rects) <= 1000 or not all(isinstance(r, list) and len(r) == 4 and all(number(v) for v in r) and r[0] != r[2] and r[1] != r[3] for r in rects):
        raise ValueError('invalid annotation rectangles')
    if not isinstance(points, list) or len(points) > 10000 or not all(isinstance(p, list) and len(p) == 2 and all(number(v) for v in p) for p in points):
        raise ValueError('invalid annotation points')
    if kind in {'ink', 'marker', 'line', 'arrow'} and len(points) < 2:
        raise ValueError('annotation needs two points')
    return dict(id=item['id'], type=kind, page=page, color=color.lower(), note=note,
                width=width, opacity=opacity, rects=rects, points=points)


def add(doc, item):
    page = doc[item['page'] - 1]
    matrix = page.transformation_matrix
    rects = [fitz.Rect(*r).normalize() * matrix for r in item['rects']]
    points = [fitz.Point(*p) * matrix for p in item['points']]
    color = tuple(int(item['color'][i:i+2], 16) / 255 for i in (1, 3, 5))
    kind = item['type']
    if kind == 'highlight':
        annot = page.add_highlight_annot([fitz.Quad(r.tl, r.tr, r.bl, r.br) for r in rects])
    elif kind == 'underline':
        annot = page.add_underline_annot([fitz.Quad(r.tl, r.tr, r.bl, r.br) for r in rects])
    elif kind in {'rectangle', 'ellipse'}:
        annot = (page.add_rect_annot if kind == 'rectangle' else page.add_circle_annot)(rects[0])
    elif kind in {'line', 'arrow'}:
        annot = page.add_line_annot(points[0], points[-1])
        if kind == 'arrow':
            annot.set_line_ends(0, 4)
    elif kind in {'ink', 'marker'}:
        annot = page.add_ink_annot([[tuple(p) for p in points]])
    elif kind == 'note':
        annot = page.add_text_annot(rects[0].tl, item['note'])
    else:
        annot = page.add_freetext_annot(rects[0], item['note'], fontsize=12, fontname='china-s', text_color=color)
    metadata = {k: v for k, v in item.items() if k not in {'note', 'id'}}
    annot.set_info(title='DSH Reader', content=item['note'], subject=PREFIX + json.dumps(metadata, ensure_ascii=True, separators=(',', ':')))
    doc.xref_set_key(annot.xref, 'NM', fitz.get_pdf_str(item['id']))
    if kind != 'freetext':
        annot.set_colors(stroke=color)
    if kind not in {'highlight', 'underline', 'note'}:
        annot.set_border(width=item['width'])
    annot.set_opacity(item['opacity'])
    annot.set_flags(annot.flags | fitz.PDF_ANNOT_IS_PRINT)
    annot.update()


@contextmanager
def exclusive_pdf(path):
    lock_path = Path(str(path) + '.dpr-lock')
    if lock_path.is_symlink():
        raise ValueError('conflict: invalid lock file')
    with lock_path.open('a+b') as lock:
        lock.seek(0, 2)
        if not lock.tell():
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError('conflict: another PDF operation is active') from None
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == 'nt':
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def process(path, request):
    with exclusive_pdf(path):
        return _process(path, request)


def ensure_original_backup(path, before):
    backup = Path(str(path) + '.dpr-original.bak')
    marker = Path(str(backup) + '.json')
    if backup.is_symlink() or marker.is_symlink():
        raise ValueError('backup path is not a regular file')
    if backup.exists() or marker.exists():
        try:
            record = json.loads(marker.read_text(encoding='utf8'))
            valid = record.get('format') == 'dpr-original-v1' and record.get('sha256') == version(backup)
        except Exception:
            valid = False
        if not valid:
            raise ValueError('backup file already exists or is invalid; original PDF was not changed')
        return
    created = False
    try:
        with backup.open('xb') as dst, path.open('rb') as src:
            created = True
            for chunk in iter(lambda: src.read(1024 * 1024), b''):
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        if version(backup) != before:
            raise ValueError('conflict: PDF changed while creating backup')
        with marker.open('x', encoding='utf8') as stream:
            json.dump({'format': 'dpr-original-v1', 'sha256': before}, stream)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        # Only remove a partial backup this operation created, never a pre-existing file.
        if created and not marker.exists() and backup.exists():
            backup.unlink()
        raise


def _process(path, request):
    path = Path(path)
    action = request.get('action', 'read')
    if action not in {'read', 'upsert', 'delete'}:
        raise ValueError('invalid action')
    before = version(path)
    if action != 'read' and request.get('version') != before:
        raise ValueError('conflict: PDF changed; reload before saving')
    temp = None
    with fitz.open(path) as doc:
        if doc.needs_pass:
            raise ValueError('encrypted PDF is not supported')
        if action == 'read':
            return {'version': before, 'items': read_items(doc), 'pages': len(doc)}
        page_count = len(doc)
        if doc.get_sigflags() > 0:
            raise ValueError('signed PDF must not be modified')
        item = validate(request.get('item'), doc) if action == 'upsert' else None
        target_id = item['id'] if item else request.get('id')
        if not isinstance(target_id, str) or not target_id.startswith('dpr-'):
            raise ValueError('invalid annotation id')
        for page in doc:
            for annot in list(page.annots() or []):
                if annot.info.get('id') == target_id:
                    if not owned(annot):
                        raise ValueError('cannot edit foreign annotation')
                    page.delete_annot(annot)
        if item:
            add(doc, item)
        fd, temp = tempfile.mkstemp(prefix='.dpr-annot-', suffix='.pdf', dir=path.parent)
        os.close(fd)
        try:
            # Preserve encryption and all unrelated PDF objects; never flatten annotations.
            doc.save(temp, encryption=fitz.PDF_ENCRYPT_KEEP, garbage=0, deflate=True)
            with fitz.open(temp) as check:
                if len(check) != len(doc):
                    raise ValueError('saved PDF verification failed')
                items = read_items(check)
            if version(path) != before:
                raise ValueError('conflict: PDF changed during save')
            ensure_original_backup(path, before)
        except BaseException:
            if temp and Path(temp).exists():
                Path(temp).unlink()
            raise
    try:
        if version(path) != before:
            raise ValueError('conflict: PDF changed during save')
        os.replace(temp, path)
    finally:
        if temp and Path(temp).exists():
            Path(temp).unlink()
    return {'version': version(path), 'items': items, 'pages': page_count}


def main():
    # File protocol avoids shell interpolation and credentials/user text in argv.
    source, destination = map(Path, sys.argv[1:3])
    try:
        request = json.loads(source.read_text(encoding='utf8'))
        result = process(request.pop('pdfPath'), request)
    except ValueError as error:
        result = {'error': str(error), 'code': 'conflict' if str(error).startswith('conflict:') else 'invalid'}
    except Exception:
        result = {'error': 'PDF operation could not be confirmed; reopen PDF and verify the original backup', 'code': 'io'}
    destination.write_text(json.dumps(result, ensure_ascii=True, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main()
