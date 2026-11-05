"""Bounded JSON reader for this reference package; not the product CLI loader.

Duplicate decoded member names, non-finite constants and lone surrogates are rejected.
Contract/codegen input additionally uses only safe-integer JSON numbers.
"""
from pathlib import Path
import json, math
MAX_BYTES = 2 * 1024 * 1024
MAX_DEPTH = 64
SAFE_INTEGER = 9007199254740991

def _members(items):
    obj = {}
    for key, value in items:
        if key in obj:
            raise ValueError('DUPLICATE_JSON_MEMBER')
        obj[key] = value
    return obj

def _bad_constant(value):
    raise ValueError('NONFINITE_JSON_NUMBER')

def decode_json(raw: bytes, *, integer_only=False):
    if len(raw) > MAX_BYTES:
        raise ValueError('JSON_TOO_LARGE')
    # The source format intentionally rejects BOM; it is not the value-string BOM rule.
    text = raw.decode('utf-8', errors='strict')
    if text.startswith('\ufeff'):
        raise ValueError('JSON_SOURCE_BOM')
    value = json.loads(text, object_pairs_hook=_members, parse_constant=_bad_constant)
    def visit(v, depth):
        if depth > MAX_DEPTH:
            raise ValueError('JSON_TOO_DEEP')
        if isinstance(v, str):
            if any(0xD800 <= ord(ch) <= 0xDFFF for ch in v):
                raise ValueError('INVALID_JSON_UNICODE')
        elif isinstance(v, bool) or v is None:
            return
        elif isinstance(v, (int,float)):
            if isinstance(v,float) and (integer_only or not math.isfinite(v)):
                raise ValueError('UNSUPPORTED_JSON_NUMBER')
            if isinstance(v,int) and abs(v) > SAFE_INTEGER:
                raise ValueError('UNSAFE_JSON_INTEGER')
        elif isinstance(v,list):
            for x in v: visit(x,depth+1)
        elif isinstance(v,dict):
            for k,x in v.items(): visit(k,depth+1);visit(x,depth+1)
    visit(value,0)
    return value

def read_json(path: Path, *, integer_only=False):
    # Read at most the configured bound, not the whole file before checking size.
    with Path(path).open('rb') as f:
        raw = f.read(MAX_BYTES+1)
    return decode_json(raw,integer_only=integer_only)
