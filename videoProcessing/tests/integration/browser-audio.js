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

  async function choose(id, value) {
    await evaluate(
      `(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  }
  const downloads =
    "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Download').length";
  await call("Page.navigate", { url: "http://127.0.0.1:19080/uc3-test" });
  await click("Manage audio");
  await wait(
    "document.querySelector('#audio-operation')?.value==='volume'",
    "Audio editor",
  );
  await wait(
    `${button("Process audio")} && !${button("Process audio")}.disabled`,
    "Audio metadata",
  );
  console.log("PASS Browser opens audio from the existing video editor");
  await fill("audio-volume", "150");
  await click("Process audio");
  await wait(
    "document.body.innerText.includes('may cause clipping and distort')",
    "Amplification warning",
  );
  assert.equal(await evaluate(downloads), 0);
  console.log(
    "PASS Browser asks for amplification confirmation without creating a result",
  );
  await click("Back to settings");
  await fill("audio-volume", "50");
  await click("Process audio");
  await wait(`${downloads}===1`, "Volume result");
  console.log("PASS Browser volume operation completes and updates library");
  await choose("audio-operation", "remove");
  await click("Process audio");
  await wait(
    "document.body.innerText.includes('no audio track')",
    "Removal confirmation",
  );
  await click("Confirm and process");
  await wait(`${downloads}===2`, "Removal result");
  console.log("PASS Browser confirms removal and saves a second result");
  const removedId = await evaluate(
    "Array.from(document.querySelector('#audio-source').options).find(o=>o.textContent.includes('_audio_remove.')).value",
  );
  await choose("audio-source", removedId);
  await wait(
    "document.querySelector('#audio-operation')?.value==='overlay' && document.querySelector('#audio-operation')?.options.length===1 && !!document.querySelector('#audio-overlay-mode') && !document.querySelector('#audio-operation').closest('fieldset').disabled",
    "Silent result selection",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#audio-overlay-mode').options.length",
    ),
    1,
  );
  console.log(
    "PASS Browser allows a saved silent result only in replacement mode",
  );
  const document = await call("DOM.getDocument");
  const input = await call("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "#auxiliary-audio",
  });
  await call("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [
      process.env.AUDIO_TEST_FILE || "/tmp/picturas-audio-test/music.wav",
    ],
  });
  await wait(
    "document.body.innerText.includes('2.000 s')",
    "Auxiliary inspected",
  );
  await wait(
    "!!document.querySelector('#audio-short-policy')",
    "Short policy shown",
  );
  assert.equal(await evaluate(`${button("Process audio")}.disabled`), true);
  await choose("audio-short-policy", "repeat");
  await fill("audio-volume", "100");
  await fill("audio-fade-in", "0.5");
  await fill("audio-fade-out", "0.5");
  await click("Process audio");
  await wait(`${downloads}===3`, "Overlay result");
  console.log(
    "PASS Browser validates upload, requires short-audio policy and overlays with fades",
  );
  await click("Preview");
  await wait("document.querySelectorAll('video').length===2", "Result preview");
  console.log("PASS Browser previews the saved result");
  await click("Trim");
  await click("Manage audio");
  await wait(`${downloads}===3`, "Recovered audio results");
  console.log("PASS Browser recovers audio tasks and library after navigation");
  const shot = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  fs.writeFileSync(
    "/validation/audio-ui.png",
    Buffer.from(shot.data, "base64"),
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS No uncaught browser exceptions during audio flow");
  ws.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
