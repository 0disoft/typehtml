/** Uses a compiled local copy of reference/wire-semantics.ts, no project code or network. */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const lib = require(process.argv[2]);
const observed = [];
const bytes = (s) => new TextEncoder().encode(s);
function check(id, fn) { fn(); observed.push({ id, status: 'VERIFIED_REFERENCE_ONLY' }); }
function rejects(body, code) { assert.throws(() => lib.parseWire(bytes(body)), e => e.code === code); }
check('plus-percent-single-decode', () => assert.deepEqual(lib.parseWire(bytes('q=a+b%2Bc%2520')), [['q','a b+c%20']]));
check('decoded-key-duplicate', () => rejects('quantity=1&%71uantity=2','DUPLICATE_KEY'));
check('malformed-percent', () => rejects('q=%G0','INVALID_PERCENT'));
check('invalid-utf8', () => rejects('q=%C0%AF','INVALID_UTF8'));
check('first-equals-and-empty-segment', () => assert.deepEqual(lib.parseWire(bytes('&&q=a=b&')), [['q','a=b']]));
check('empty-and-missing', () => { assert.deepEqual(lib.parseWire(bytes('q')), [['q','']]); assert.deepEqual(lib.parseWire(bytes('')), []); });
check('bom-is-value', () => assert.deepEqual(lib.parseWire(bytes('q=%EF%BB%BFx')), [['q','\uFEFFx']]));
check('unsafe-key', () => rejects('constructor=x','INVALID_KEY'));
check('unexpected-reserved', () => rejects('_bc_admin=1','INVALID_KEY'));
check('nul', () => rejects('q=%00','NUL_NOT_ALLOWED'));
check('bounded-body', () => assert.throws(() => lib.parseWire(bytes('q=123'), {maxBytes:4,maxEntries:16,maxKeyBytes:64,maxValueBytes:1024}), e => e.code==='BODY_TOO_LARGE'));
check('integer-codec', () => { assert.equal(lib.decimalInteger('9007199254740991'),9007199254740991); for(const x of ['01','+1','-0','1e2','1.0',' 1','']) assert.throws(() => lib.decimalInteger(x)); assert.throws(() => lib.decimalInteger('9007199254740992')); });
check('unicode-units', () => assert.deepEqual(lib.lengthUnits('😀'), {codePoints:1,utf16:2,utf8:4}));
let canonical;
check('typed-canonical-input', () => { canonical=lib.canonicalInput({quantity:2,productId:'p_100'}); assert.equal(canonical,lib.canonicalInput({productId:'p_100',quantity:2})); assert.notEqual(canonical,lib.canonicalInput({productId:'p_100',quantity:'2'})); assert.notEqual(lib.canonicalInput({note:''}),lib.canonicalInput({})); });
check('lone-surrogate-rejected', () => assert.throws(() => lib.canonicalInput({note:'\uD800'}),e=>e.code==='INVALID_DOMAIN_UNICODE'));
console.log(JSON.stringify({node:process.version,scope:'bounded reference wire/codec/canonical functions, not HTTP runtime',checks:observed,canonicalInput:canonical,sha256:createHash('sha256').update(canonical,'utf8').digest('hex'),notRun:['HTTP stream','schema runtime','CSRF','Doctor','performance']},null,2));
