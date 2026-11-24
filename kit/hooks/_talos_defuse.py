"""_talos_defuse.py: make one line of a note's text (a title, a description, a file name) safe to show the agent inside a data block.
Not a hook itself; nothing registers it. hooks/memory-reflex.py imports it; if it cannot be imported, the hook prints NO pointers.

Text that comes back from the owner's notes was written by someone (a message, a web page, an email, a transcript) and may try to look
like harness markup or an order. `defuse(text)` returns the same line, in this order, and applying it twice gives the same text:
  1. white space collapsed to single spaces (so no order can hide across a line break), then every character that draws nothing removed
     (control, zero-width, bidi, invisible operators, tag block, variation selectors, fillers), then white space collapsed again;
  2. characters that fold to one ASCII character (full-width forms, circled and math letters) folded, so a full-width `<channel>` is
     the tag it spells;
  3. fake control tags neutralised (their `<` becomes a visible single angle quote), also when spelled with `&lt;`, `&#60;` or `&#x3c;`
     (stricter than the reference): the harness's own tags, tool-call and role tags, `<name-with-dash/>`, chat-template tokens;
  4. a line that reads like an order to the model gets the FLAG prefix (the text is kept: it is evidence, not a command);
  5. the same tag scan as packages/protocol/src/untrusted.ts neutralizeControlTags (a port: its folds, homoglyphs and boundary rule),
     which also sees a bracket look-alike, a homoglyph letter or a hidden character inside a tag;
  6. `===` rewritten, so no `=== end ... ===` can close a wrapper.
The TypeScript twin is apps/bridge/src/memory/reflex-sanitize.ts (steps 1 to 4, then the protocol's own function for step 5); the parity
test keeps them equal. The patterns are ASCII-only (re.ASCII here, no `u` flag there), so a letter such as e-acute behaves alike on both
sides. Python 3.9, standard library only."""
import re
import unicodedata

import _talos_common as C

FLAG = "[flagged: instruction-like text in source]"
LT = "‹"        # the quote the bridge's own tag neutraliser uses

# every character that draws nothing: C0/C1 controls plus the Unicode default-ignorable code points, LISTED here (Python's own Unicode tables
# differ between 3.9 and later): soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent vowels, Mongolian
# variation selectors and vowel separator, zero-width and bidi characters, the invisible operators (2060-206F), variation selectors, BOM,
# half-width Hangul filler, the specials FFF0-FFFB (the interlinear annotation marks too), the Bamum/Duployan shorthand format controls
# (1BCA0-1BCA3), the musical symbol format controls (1D173-1D17A), the Unicode tag block
DEFAULT_IGNORABLE = ("\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0"
                     "\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff")
_INVISIBLE = re.compile("[\x00-\x1f\x7f-\x9f" + DEFAULT_IGNORABLE + "]")
_DI = re.compile("[" + DEFAULT_IGNORABLE + "]")
_WS = re.compile(r"\s+")

_TAG_NAMES = ("system-reminder", "channel", "cross-session-message", "function_calls", "function_results", "invoke", "parameter",
              "task-notification", "teammate-message", "tool_use_error", "user-prompt-submit-hook", "system", "assistant", "human",
              "user", "tool_use", "tool_call", "tool_result", "thinking", "untrusted-content", "bash-input", "bash-stdout", "bash-stderr")
_NAMES = ("|".join(re.sub(r"[-_]", "[-_]", n) for n in _TAG_NAMES)
          + r"|(?:scheduled|command|local[-_]command)[-_][\w-]+|antml:[\w:.-]+|[\w-]*[-_]hook")
_TAG = re.compile(r"(?:<|&lt;|&#0*60;|&#x0*3c;)(?=\s*/?\s*(?:" + _NAMES + r")(?=[\s/>&]|$))", re.I | re.A)
_TEMPLATE = re.compile(r"<(?=\|[^|<>\n]{1,40}\|>)", re.A)                   # chat-template tokens: <|im_start|>
_SELFCLOSE = re.compile(r"<(?=[A-Za-z][\w.]*[-:_][\w:.-]*(?:\s[^<>]*)?/>)", re.A)
_ORDERS = [re.compile(p, re.I | re.A) for p in (
    r"\b(?:ignore|disregard|forget|override)\b[^.\n]{0,25}\b(?:previous|prior|above|earlier|preceding|all)\b[^.\n]{0,25}\b(?:instructions?|prompts?|rules|directions?|context)\b",
    r"\bforget (?:everything|all|what) (?:you|i|we)\b",
    r"\byou are now\b",
    r"\bnew (?:system )?instructions\b",
    r"^\s*(?:[#>*\-\s]*)(?:system|assistant|developer)\s*:",
    r"\bfrom now on,? you\b",
    r"\bact as (?:if you (?:are|were)|an? (?:unrestricted|jailbroken))\b",
    r"\b(?:reveal|print|show|repeat) (?:your|the) (?:system )?prompt\b",
    r"<<\s*SYS\s*>>|\[INST\]",
)]

# ---- the protocol's scan (packages/protocol/src/untrusted.ts), ported: finds a control tag in a FOLDED view of the text
_OPEN = r"(?:<|&lt;?|&#0*60;?|&#x0*3c;?)"
_CONTROL_TAG = re.compile(
    _OPEN + r"[\s/]*(?:channel|system[-_]reminder|system|cross[-_]session[-_]message|task[-_]notification|teammate[-_]message|tool_use_error|thinking|"
    r"command-(?:name|message|args)|local-command-(?:stdout|stderr|caveat)|user-prompt-submit-hook|bash-(?:input|stdout|stderr)|function_calls|"
    r"function_results|invoke|parameter|antml:[a-z_]+)", re.I | re.A)
_LEADING = re.compile("^" + _OPEN, re.I | re.A)
_FOLDS = {
    0xff1c: '<', 0xff1e: '>', 0x2329: '<', 0x232a: '>', 0x3008: '<', 0x3009: '>', 0x2039: '<', 0x203a: '>', 0x27e8: '<',
    0x27e9: '>', 0xfe64: '<', 0xfe65: '>', 0xab: '<', 0xbb: '>', 0x300a: '<', 0x300b: '>', 0x27ea: '<', 0x27eb: '>', 0x27ec: '<',
    0x27ed: '>', 0x27ee: '<', 0x27ef: '>', 0x276c: '<', 0x276d: '>', 0x276e: '<', 0x276f: '>', 0x2c2: '<', 0x2c3: '>',
    0x1438: '<', 0x1433: '>', 0x2770: '<', 0x2771: '>', 0x2f1: '<', 0x2f2: '>', 0x29fc: '<', 0x29fd: '>', 0x2991: '<',
    0x2992: '>', 0x25c1: '<', 0x25b7: '>', 0x2264: '<', 0x2265: '>', 0x2215: '/', 0x2044: '/', 0x29f8: '/', 0x200b: '',
    0x200c: '', 0x200d: '', 0x2060: '', 0xfeff: '', 0xad: '',
}
_HOMOGLYPHS = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
    'Ѕ': 'S', 'Ј': 'J', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'Α': 'A',
    'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y',
    'Χ': 'X', 'ο': 'o', 'ρ': 'p', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'ɩ': 'i', 'ι': 'i', 'κ': 'k', 'ν': 'v',
    'η': 'n', 'υ': 'u', 'τ': 't', 'т': 't', 'к': 'k', 'м': 'm', 'н': 'h', 'г': 'r', 'в': 'b', 'у': 'y', 'ї': 'i', 'ґ': 'r',
}
_SKIP_EXTRA = "⠀ㅤﾠᅟᅠ"


def _skip(c):
    """A character the scan ignores: it shows nothing a reader would take for a letter (control, format, combining, default-ignorable)."""
    if c in "\t\n\r":
        return False
    cat = unicodedata.category(c)
    return cat in ("Cc", "Cf") or cat.startswith("M") or c in _SKIP_EXTRA or bool(_DI.match(c))


def _folded_view(text):
    folded, start, end = [], [], []
    for i, cp in enumerate(text):
        for c in unicodedata.normalize("NFKD", cp):
            if _skip(c):
                continue
            mapped = c if ord(c) < 0x80 else _FOLDS.get(ord(c), _HOMOGLYPHS.get(c, c))
            for ch in mapped:
                folded.append(ch)
                start.append(i)
                end.append(i + 1)
    return "".join(folded), start, end


def neutralize_control_tags(text):
    """Every control-tag look-alike in `text` (also spelled with full-width or homoglyph characters, hidden characters or an entity for
    `<`) loses its `<` for a visible single angle quote; the rest is unchanged. The name must END there (`<channels>` is a word)."""
    folded, start, end = _folded_view(text)
    hits = []
    for m in _CONTROL_TAG.finditer(folded):
        j = m.end()
        gap = j < len(folded) and end[j - 1] < start[j]
        if not (j >= len(folded) or re.match(r"[\s>/]", folded[j]) or gap):
            continue
        hits.append((start[m.start()], end[m.end() - 1], _LEADING.sub(LT, m.group(0))))
    if not hits:
        return text
    out, cursor = [], 0
    for s, e, v in hits:
        if s < cursor:
            continue
        out.append(text[cursor:s] + v)
        cursor = e
    return "".join(out) + text[cursor:]


def clean(text):
    """Step 1: white space, then everything that draws nothing, then white space again."""
    t = _WS.sub(" ", (text if isinstance(text, str) else str(text or "")).strip())
    return _WS.sub(" ", _INVISIBLE.sub("", t)).strip()


def _fold1(text):
    """NFKC, but only for a character that folds to ONE ASCII character (full-width, small-form, circled, math letters): an ellipsis stays."""
    if text.isascii():
        return text
    out = []
    for c in text:
        if ord(c) > 127 and unicodedata.category(c) != "No":
            n = unicodedata.normalize("NFKC", c)
            if len(n) == 1 and n.isascii():
                c = n
        out.append(c)
    return "".join(out)


def fold_for_scan(text):
    """The text as the owner-rule scan sees it: no hidden character, look-alike brackets and letters folded, lower case."""
    return _folded_view(text)[0].lower()


def sanitize(text):
    """Steps 1 to 4 (the TypeScript sanitizeNote)."""
    t = _fold1(clean(text))
    for _ in range(16):                        # to a fixed point: neutralising never builds a tag, but be certain
        u = _SELFCLOSE.sub(LT, _TEMPLATE.sub(LT, _TAG.sub(LT, t)))
        if u == t:
            break
        t = u
    if not t.lstrip().startswith(FLAG) and any(p.search(t) for p in _ORDERS):
        t = FLAG + " " + t
    return t


def defuse(text):
    """One line of note text made safe to put inside a data block (steps 1 to 6). A caller that gets an exception shows no pointer."""
    return C.as_data(clean(neutralize_control_tags(sanitize(text))))
