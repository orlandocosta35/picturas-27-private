const assert = require("node:assert/strict");
const fs = require("fs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const targets = await (
    await fetch("http://127.0.0.1:19223/json/list")
  ).json();
  const ws = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(m.error) : p.resolve(m.result);
      }
    }
    if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails.text);
  });
  function call(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("CDP timeout " + method));
        }
      }, 30000).unref();
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await call("Runtime.enable");
  await call("Page.enable");
  async function evaluate(expression) {
    const r = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async function wait(expression, label, ms = 90000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await pause(200);
    }
    throw new Error(label + ": " + (await evaluate("document.body.innerText")));
  }
  const button = (text) =>
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
  async function click(text) {
    await wait(`${button(text)} && !${button(text)}.disabled`, text);
    await evaluate(`${button(text)}.click()`);
  }
  async function fill(id, value) {
    await evaluate(
      `(()=>{const e=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  }
  await call("Page.navigate", { url: "http://127.0.0.1:19080/uc2-test" });
  await wait(
    "document.querySelector('#trim-end-time')?.value==='00:06.000'",
    "Metadata loaded",
  );
  await wait(
    `${button("Trim video")} && !${button("Trim video")}.disabled`,
    "Task list loaded",
  );
  console.log(
    "PASS Browser loads real trim editor, metadata and saved results",
  );
  await click("Trim video");
  await wait(
    "document.body.innerText.includes('There is nothing to trim')",
    "No-op notice",
  );
  console.log("PASS Browser full interval consumes no operation");
  const before = await evaluate(
    "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Download').length",
  );
  await fill("trim-start-time", "00:00.500");
  await fill("trim-end-time", "00:03.500");
  await click("Trim video");
  await wait(
    "document.body.innerText.includes('Available range:') || document.body.innerText.includes('Completed · 100%')",
    "Fast trim confirmation or completion after keyframe snapping",
  );
  if (await evaluate("document.body.innerText.includes('Available range:')")) {
    await click("Confirm available range");
    console.log("PASS Browser confirms effective fast boundaries");
  } else {
    console.log("PASS Browser uses keyframe-aligned fast boundaries");
  }
  await wait(
    "document.body.innerText.includes('Completed · 100%')",
    "Fast completion",
  );
  await wait(
    `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Download').length===${before + 1}`,
    "Results refreshed",
  );
  console.log("PASS Browser fast trim completes and refreshes library");
  await evaluate(
    "(()=>{const s=document.querySelector('#trim-mode');s.value='precise';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await fill("trim-start-time", "00:01.250");
  await fill("trim-end-time", "00:03.250");
  await click("Trim video");
  await wait(
    `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Download').length===${before + 2}`,
    "Precise result",
  );
  console.log("PASS Browser precise trim completes");
  await click("Leave editor");
  await click("Back to editor");
  await wait(
    `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Download').length===${before + 2}`,
    "Results recovered",
  );
  console.log("PASS Browser restores library after leaving and returning");
  const shot = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  fs.writeFileSync("/validation/trim-ui.png", Buffer.from(shot.data, "base64"));
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS No uncaught browser exceptions");
  ws.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
