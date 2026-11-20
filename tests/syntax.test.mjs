import test from "node:test";
import assert from "node:assert/strict";
import { syntaxLanguage, syntaxTokens, highlightDiff, colorIdentifiers, identifierColor } from "../mods/annotator/syntax.js";

test("lexical colors preserve exact source including indentation, Unicode and markup", () => {
  for (const [path, text] of [
    ["file.ts", '  const emoji = "🦀 <script>\\\""; // comment'],
    ["file.rs", "pub fn fee(amount: u64) -> u64 { amount / 100 }"],
    ["file.py", "    if value is None: print('hello # world') # note"],
    ["file.sql", "SELECT id FROM users WHERE active = TRUE; -- note"],
    ["file.json", '  "answer": 42,'],
    ["file.yml", 'name: "value # data" # note'],
    ["file.sh", 'if [ "$value" = "ok" ]; then echo 1; fi # note'],
  ]) {
    const tokens = syntaxTokens(text, syntaxLanguage(path));
    assert.equal(tokens.map(t => t.text).join(""), text);
    assert.ok(tokens.some(t => t.kind !== "plain"), path);
  }
});

test("strings protect comment markers and JSON keys get their own token", () => {
  const ts = syntaxTokens('const url = "https://example.test"; // actual', "js");
  assert.equal(ts.filter(t => t.kind === "comment").map(t => t.text).join(""), "// actual");
  assert.ok(ts.some(t => t.kind === "keyword" && t.text === "const"));
  assert.ok(syntaxTokens('"name": "value"', "json").some(t => t.kind === "property" && t.text === '"name"'));
  assert.ok(syntaxTokens("fn get<'a>(v: &'a str) -> &'a str { v }", "rust").every(t => t.kind !== "string"));
});

test("old and new sides keep independent multiline states and reset at hidden gaps", () => {
  const rows = [
    { kind: "delete", old: 1, new: null, text: "/* removed opener" },
    { kind: "add", old: null, new: 1, text: "const fresh = 1;" },
    { kind: "context", old: 2, new: 2, text: "unchanged text" },
    { kind: "context", old: 10, new: 10, text: "return value;" },
  ];
  const tokens = highlightDiff(rows, "file.ts");
  assert.ok(tokens.get("old:2").every(t => t.kind === "comment"));
  assert.ok(tokens.get("new:1").some(t => t.kind === "keyword"));
  assert.ok(tokens.get("new:2").every(t => t.kind !== "comment"));
  assert.ok(tokens.get("old:10").some(t => t.kind === "keyword"));
});

test("multiline strings continue only across visible consecutive source lines", () => {
  const state = {};
  syntaxTokens('value = """first', "python", state);
  assert.equal(state.quote, '"""');
  const next = syntaxTokens('second""" # end', "python", state);
  assert.ok(next.some(t => t.kind === "comment"));
  assert.equal(state.quote, null);
});

test("unknown languages and extreme lines use bounded plain rendering", () => {
  assert.equal(syntaxLanguage("notes.txt"), null);
  assert.equal(highlightDiff([{ old: 1, new: 1, text: "plain" }], "notes.txt").size, 0);
  for (const text of ["x".repeat(9000), "const x = 1; ".repeat(300)]) {
    const tokens = syntaxTokens(text, "js");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "plain");
    assert.equal(tokens[0].text, text);
  }
});

const kinds = (tokens, kind) => tokens.filter(t => t.kind === kind).map(t => t.text.trim());

test("Scala and Gradle/Groovy, Markdown and schema files have a language", () => {
  for (const [path, language] of [
    ["src/Main.scala", "scala"], ["script.sc", "scala"],
    ["build.gradle", "groovy"], ["Task.groovy", "groovy"], ["ci/Jenkinsfile", "groovy"],
    ["README.md", "markdown"], ["notes.markdown", "markdown"],
    ["schema/Event.avsc", "json"], ["com/linkedin/Foo.pdl", "pdl"],
  ]) assert.equal(syntaxLanguage(path), language, path);
});

test("Scala colors keywords, interpolators, char literals and suffixed numbers", () => {
  const text = '  implicit val label: String = s"id=$id" + \'x\' + 100L // note';
  const tokens = syntaxTokens(text, "scala");
  assert.equal(tokens.map(t => t.text).join(""), text);
  assert.deepEqual(kinds(tokens, "keyword"), ["implicit", "val"]);
  assert.ok(tokens.some(t => t.kind === "string" && t.text.startsWith('s"id=')), "interpolator prefix belongs to the string");
  assert.ok(kinds(tokens, "string").some(s => s.includes("'x'")));
  assert.ok(kinds(tokens, "number").includes("100L"));
  assert.ok(kinds(tokens, "comment").includes("// note"));
  for (const word of ["case", "object", "trait", "sealed", "given", "using", "extension", "lazy", "match", "yield"]) {
    assert.ok(syntaxTokens(`${word} x`, "scala").some(t => t.kind === "keyword" && t.text === word), word);
  }
});

test("Scala symbols are not strings and triple-quoted strings span lines", () => {
  assert.ok(syntaxTokens("val k = 'foo + 'x'", "scala").every(t => !(t.kind === "string" && t.text.includes("foo"))));
  const state = {};
  syntaxTokens('val sql = s"""SELECT // not a comment', "scala", state);
  assert.equal(state.quote, '"""');
  const next = syntaxTokens('  FROM t""" // comment', "scala", state);
  assert.ok(next[0].kind === "string" && next[0].text.includes('FROM t"""'));
  assert.ok(next.some(t => t.kind === "comment"));
  assert.equal(state.quote, null);
});

test("Scala doc comments continue across lines", () => {
  const rows = ["/**", "  * What `bid` means, e.g. don't", "  */", "case class A(lid: Long)"]
    .map((text, i) => ({ kind: "add", old: null, new: i + 1, text }));
  const tokens = highlightDiff(rows, "Geo.scala");
  for (const line of [1, 2, 3]) assert.ok(tokens.get(`new:${line}`).every(t => t.kind === "comment"), `line ${line}`);
  assert.ok(tokens.get("new:4").some(t => t.kind === "keyword" && t.text.includes("case")));
});

test("Gradle colors DSL calls, keywords and triple-quoted strings", () => {
  const text = "    implementation 'com.example:lib:1.0' // pinned";
  const tokens = syntaxTokens(text, "groovy");
  assert.equal(tokens.map(t => t.text).join(""), text);
  assert.ok(kinds(tokens, "function").includes("implementation"));
  assert.ok(kinds(tokens, "string").includes("'com.example:lib:1.0'"));
  assert.ok(syntaxTokens("dependencies {", "groovy").some(t => t.kind === "function" && t.text === "dependencies"));
  assert.ok(syntaxTokens("def task = project.tasks", "groovy").some(t => t.kind === "keyword" && t.text === "def"));
  const state = {};
  syntaxTokens("def s = '''first", "groovy", state);
  assert.equal(state.quote, "'''");
});

test("Markdown colors headings, quotes, list markers, code spans, emphasis and links", () => {
  const md = text => syntaxTokens(text, "markdown");
  for (const text of ["## Testing Done", "> quoted", "- item with `code` and **bold** [link](https://x.test)", "1. it's fine"]) {
    assert.equal(md(text).map(t => t.text).join(""), text);
  }
  assert.deepEqual(md("## Testing Done").map(t => t.kind), ["keyword"]);
  assert.deepEqual(md("> quoted").map(t => t.kind), ["comment"]);
  const item = md("- item with `code` and **bold** [link](https://x.test)");
  assert.equal(item[0].kind, "number");
  assert.ok(kinds(item, "string").includes("`code`"));
  assert.ok(kinds(item, "type").includes("**bold**"));
  assert.ok(kinds(item, "function").includes("[link]"));
  assert.ok(kinds(item, "comment").includes("(https://x.test)"));
  assert.ok(md("1. it's fine").every(t => t.kind !== "string"), "apostrophes are prose");
  assert.ok(md("#hashtag").every(t => t.kind !== "keyword"));
});

test("Markdown fenced code is not read as Markdown", () => {
  const state = {};
  assert.deepEqual(syntaxTokens("```sh", "markdown", state).map(t => t.kind), ["comment"]);
  assert.deepEqual(syntaxTokens("# not a heading", "markdown", state).map(t => t.kind), ["string"]);
  assert.deepEqual(syntaxTokens("```", "markdown", state).map(t => t.kind), ["comment"]);
  assert.deepEqual(syntaxTokens("# heading", "markdown", state).map(t => t.kind), ["keyword"]);
});

test("PDL colors schema keywords, primitive types and field names", () => {
  const text = '  optionalField?: union[null, string] = null // doc';
  const tokens = syntaxTokens(text, "pdl");
  assert.equal(tokens.map(t => t.text).join(""), text);
  assert.ok(kinds(tokens, "property").includes("optionalField"));
  assert.ok(kinds(tokens, "keyword").includes("union"));
  assert.ok(tokens.some(t => t.kind === "keyword" && t.text === "string"));
  for (const word of ["namespace", "record", "enum", "typeref", "includes", "import"]) {
    assert.ok(syntaxTokens(`${word} X`, "pdl").some(t => t.kind === "keyword" && t.text === word), word);
  }
});

test("number suffixes never swallow identifiers", () => {
  assert.ok(syntaxTokens("let x = 1f32;", "rust").every(t => t.text !== "1f"));
  assert.ok(kinds(syntaxTokens("long n = 10L;", "c"), "number").includes("10L"));
});

test("Scala triple-quoted strings are raw, so a trailing backslash still closes them", () => {
  const state = {};
  const tokens = syntaxTokens('val re = """\\d+\\""" // digits', "scala", state);
  assert.ok(!state.quote);
  assert.ok(kinds(tokens, "comment").includes("// digits"));
  syntaxTokens('val sql = """first', "scala", state);
  syntaxTokens('C:\\dir\\""" + x', "scala", state);
  assert.equal(state.quote, null);
});

test("Markdown underscores inside words are not emphasis", () => {
  const tokens = syntaxTokens("call foo__bar__baz now", "markdown");
  assert.ok(tokens.every(t => t.kind === "plain"));
  assert.ok(kinds(syntaxTokens("a __strong__ word", "markdown"), "type").includes("__strong__"));
});

const rowsOf = lines => lines.map((text, i) => ({ kind: "context", old: i + 1, new: i + 1, text }));

test("semantic colors give each identifier one slot per file in first-appearance order", () => {
  const rows = rowsOf(["val record = parse(line)", "record.id + count", "  // record in a comment"]);
  const colored = colorIdentifiers(highlightDiff(rows, "A.scala"), "A.scala");
  const slots = (key, name) => colored.get(key).filter(t => t.text === name).map(t => [t.kind, t.slot]);
  assert.deepEqual(slots("new:1", "record"), [["variable", 0]]);
  assert.deepEqual(slots("new:1", "line"), [["variable", 1]]);
  assert.deepEqual(slots("new:2", "record"), [["variable", 0]], "same name, same color on later lines");
  assert.deepEqual(slots("old:2", "record"), [["variable", 0]], "and on the other diff side");
  assert.deepEqual(slots("new:2", "id"), [["variable", 2]]);
  assert.deepEqual(slots("new:2", "count"), [["variable", 3]]);
  assert.ok(colored.get("new:1").some(t => t.kind === "keyword" && t.text === "val"));
  assert.ok(colored.get("new:1").some(t => t.kind === "function" && t.text === "parse"), "calls keep their color");
  assert.ok(colored.get("new:3").every(t => t.kind !== "variable"), "comments are untouched");
  for (const [key, tokens] of colored) assert.equal(tokens.map(t => t.text).join(""), rows[Number(key.split(":")[1]) - 1].text);
});

test("semantic colors skip prose and data files and never split oversized lines", () => {
  for (const path of ["README.md", "data.json", "app.yml", "page.html", "site.css"]) {
    const tokens = highlightDiff(rowsOf(["some words here: value"]), path);
    const colored = colorIdentifiers(tokens, path);
    assert.ok([...colored.values()].flat().every(t => t.kind !== "variable"), path);
  }
  const busy = Array.from({ length: 150 }, (_, i) => `a${i}`).join(" + ");
  const tokens = highlightDiff(rowsOf([busy]), "busy.ts");
  assert.deepEqual(colorIdentifiers(tokens, "busy.ts").get("new:1"), tokens.get("new:1"));
});

test("identifier palette has twelve distinct readable hues for dark and light themes", () => {
  for (const dark of [true, false]) {
    const colors = Array.from({ length: 12 }, (_, slot) => identifierColor(slot, dark));
    assert.equal(new Set(colors).size, 12);
    assert.ok(colors.every(c => /^#[0-9a-f]{6}$/.test(c)));
    assert.equal(identifierColor(12, dark), colors[0], "slots wrap around the palette");
    const luminance = c => { const n = parseInt(c.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
    assert.ok(colors.every(c => dark ? luminance(c) > 140 : luminance(c) < 120), `${dark ? "dark" : "light"} theme contrast`);
  }
});
