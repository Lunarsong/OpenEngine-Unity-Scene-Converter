'use strict';
// Minimal Unity-YAML parser — exactly the subset Unity's serializer emits:
//   --- !u!<classId> &<fileID> [stripped]
//   2-space indented block mappings, sequences at parent-key indent ("- item"),
//   inline flow maps {k: v, ...} / flow lists [a, b], single/double-quoted scalars.
// fileIDs routinely exceed 2^53 (e.g. 568364820087899322) so every anchor,
// fileID and guid is kept as a STRING. Never Number() an anchor.

const DOC_RE = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/;

function unquote(s) {
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'")
        return s.slice(1, -1).replace(/''/g, "'");
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    return s;
}

// Parse an inline flow value: {k: v, ...} or [a, b] or scalar.
function parseFlow(s) {
    s = s.trim();
    if (s.startsWith('{')) {
        const inner = s.slice(1, s.endsWith('}') ? -1 : s.length).trim();
        const obj = {};
        for (const part of splitTop(inner)) {
            const ci = part.indexOf(':');
            if (ci < 0) continue;
            obj[part.slice(0, ci).trim()] = parseFlow(part.slice(ci + 1).trim());
        }
        return obj;
    }
    if (s.startsWith('[')) {
        const inner = s.slice(1, s.endsWith(']') ? -1 : s.length).trim();
        return inner === '' ? [] : splitTop(inner).map(p => parseFlow(p.trim()));
    }
    return unquote(s);
}

// Split on top-level commas (depth-aware for nested {}/[] and quotes).
function splitTop(s) {
    const out = [];
    let depth = 0, start = 0, q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
        if (c === "'" || c === '"') q = c;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    if (start < s.length) out.push(s.slice(start));
    return out;
}

function indentOf(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    return i;
}

// Parses lines[from..to) at the given indent. Returns { value, next }.
function parseBlock(lines, from, to, indent) {
    if (from >= to) return { value: null, next: from };
    const firstTrim = lines[from].slice(indentOf(lines[from]));
    if (indentOf(lines[from]) === indent && firstTrim.startsWith('- '))
        return parseSequence(lines, from, to, indent);
    return parseMapping(lines, from, to, indent);
}

function parseSequence(lines, from, to, indent) {
    const arr = [];
    let i = from;
    while (i < to) {
        const line = lines[i];
        const ind = indentOf(line);
        if (ind !== indent || !line.slice(ind).startsWith('- ')) break;
        const rest = line.slice(ind + 2);
        // Item is a mapping whose first key is inline: "- target: {...}"
        // with continuation keys at indent+2.
        const mapMatch = /^([A-Za-z_][\w .\-\[\]$]*?):(?: (.*))?$/.exec(rest);
        if (mapMatch && !rest.startsWith('{') && !rest.startsWith('[')) {
            // Collect continuation lines (indent + 2, not new items).
            let j = i + 1;
            while (j < to) {
                const jInd = indentOf(lines[j]);
                if (jInd <= indent) break;
                j++;
            }
            const virtual = [' '.repeat(indent + 2) + rest, ...lines.slice(i + 1, j)];
            const { value } = parseMapping(virtual, 0, virtual.length, indent + 2);
            arr.push(value);
            i = j;
        } else {
            arr.push(parseFlow(rest));
            i++;
        }
    }
    return { value: arr, next: i };
}

function parseMapping(lines, from, to, indent) {
    const obj = {};
    let i = from;
    let lastKey = null;
    while (i < to) {
        const line = lines[i];
        const ind = indentOf(line);
        if (ind < indent) break;
        const trimmed = line.slice(ind);
        if (ind === indent && trimmed.startsWith('- ')) break; // sequence of the parent
        if (ind > indent) {
            // Continuation of the previous scalar (Unity wraps some long
            // strings). Append with a space; tolerate rather than fail.
            if (lastKey !== null && typeof obj[lastKey] === 'string')
                obj[lastKey] += ' ' + trimmed;
            i++;
            continue;
        }
        const m = /^(\S[^:]*?):(?: (.*))?$/.exec(trimmed);
        if (!m) { i++; continue; } // unparseable — skip defensively
        const key = unquote(m[1]);
        const rest = m[2];
        if (rest === undefined || rest === '') {
            // Nested block, same-indent sequence, or empty scalar.
            let j = i + 1;
            if (j < to) {
                const jInd = indentOf(lines[j]);
                const jTrim = lines[j].slice(jInd);
                if (jInd === indent && jTrim.startsWith('- ')) {
                    const r = parseSequence(lines, j, to, indent);
                    obj[key] = r.value;
                    i = r.next; lastKey = key;
                    continue;
                }
                if (jInd > indent) {
                    const r = parseBlock(lines, j, to, jInd);
                    obj[key] = r.value;
                    i = r.next; lastKey = key;
                    continue;
                }
            }
            obj[key] = '';
            i++; lastKey = key;
        } else {
            obj[key] = (rest.startsWith('{') || rest.startsWith('[')) ? parseFlow(rest) : unquote(rest);
            i++; lastKey = key;
        }
    }
    return { value: obj, next: i };
}

// Parse a full Unity YAML file (scene/prefab) into an array of documents:
//   { classId: '1001', anchor: '51115', stripped: false, type: 'PrefabInstance', data: {...} }
// `wantedClassIds`: optional Set of classId strings — other docs get data=null
// (still counted), which keeps 47 MB scenes fast to parse.
function parseUnityYaml(text, wantedClassIds) {
    const lines = text.split('\n');
    const docs = [];
    let i = 0;
    const n = lines.length;
    while (i < n) {
        const m = DOC_RE.exec(lines[i].replace(/\r$/, ''));
        if (!m) { i++; continue; }
        const classId = m[1], anchor = m[2], stripped = !!m[3];
        let j = i + 1;
        while (j < n && !lines[j].startsWith('--- ')) j++;
        let type = null, data = null;
        if (!wantedClassIds || wantedClassIds.has(classId)) {
            // First body line is "TypeName:"; body follows at indent 2.
            if (j > i + 1) {
                const head = /^([A-Za-z_][\w]*):\s*$/.exec(lines[i + 1].replace(/\r$/, ''));
                if (head) {
                    type = head[1];
                    const body = lines.slice(i + 2, j).map(l => l.replace(/\r$/, ''));
                    data = parseMapping(body, 0, body.length, 2).value;
                } else {
                    // Single-line body (rare) — parse whole doc body as mapping.
                    const body = lines.slice(i + 1, j).map(l => l.replace(/\r$/, ''));
                    data = parseMapping(body, 0, body.length, 0).value;
                }
            }
        }
        docs.push({ classId, anchor, stripped, type, data });
        i = j;
    }
    return docs;
}

module.exports = { parseUnityYaml, parseFlow };
