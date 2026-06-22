// Integration test: the CommitStore against a REAL gateway over HTTP.
// Exercises the two personas (Mongo find / redux dispatch), non-destructive undo/redo, and the
// divergence doctrine (detected, never auto-merged; reconciled explicitly). Run via:
//   sh run_test_client.sh test_store.mjs
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {GatewayClient} from "../../../clients/js/client.mjs";
import {CommitStore, actions} from "../../../clients/js/store.mjs";

const VIS = "Graph::Vertex.visualAttributes";
const vdoc = (v) => ({value: v, color: {red: 0, green: 0, blue: 0}});
let pass = 0, fail = 0;

async function test(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.log(`  ✗ ${name}\n        ${e}`);
    }
}

const client = new GatewayClient(process.env.GATEWAY_URL || "http://127.0.0.1:8787");
console.log("commit store (3b) integration (real HTTP)\n");

const store = await CommitStore.open(client, "a.graph");
const KEY = {instance: randomUUID()};

await test("open -> getState holds a head (head-as-state)", () => {
    const s = store.getState();
    assert.equal(s.database, "a.graph");
    assert.equal(s.head.length, 40);
    assert.equal(s.canUndo, false);
});

await test("collection.find (Mongo read) at the held head", async () => {
    const rows = await store.collection(VIS).find({value: {$gte: 2}});
    assert(rows.length >= 1 && rows.every((r) => r.document.value >= 2));
});

await test("dispatch (redux set) advances the head + read-back", async () => {
    const before = store.getState().head;
    await store.dispatch(actions.set(VIS, KEY, vdoc(50)), "set 50");
    assert.notEqual(store.getState().head, before);
    assert.equal(store.getState().canUndo, true);
    assert.equal((await store.collection(VIS).findOne(KEY)).value, 50);
});

await test("collection.updateOne (Mongo $set) -> verb -> value 7", async () => {
    await store.collection(VIS).updateOne(KEY, {$set: {value: 7}});
    assert.equal((await store.collection(VIS).findOne(KEY)).value, 7);
});

await test("subscribe fires on dispatch with the new state", async () => {
    let got = null;
    const off = store.subscribe((s) => {
        got = s;
    });
    await store.dispatch(actions.update(VIS, KEY, "value", 8), "set 8");
    off();
    assert(got && got.head === store.getState().head);
});

await test("undo/redo toggles via the disable-commit (faithful CommitUndoStack)", async () => {
    const col = store.collection(VIS);
    assert.equal((await col.findOne(KEY)).value, 8);
    await store.undo();
    assert.notEqual((await col.findOne(KEY))?.value, 8);  // 1st undo: disableCommit(c8) + record it
    await store.redo();
    assert.equal((await col.findOne(KEY)).value, 8);      // redo: disable the disable-commit
    await store.undo();
    assert.notEqual((await col.findOne(KEY))?.value, 8);  // 2nd undo: ENABLE the disable-commit (the toggle branch)
    await store.redo();
    assert.equal((await col.findOne(KEY)).value, 8);      // redo again
    assert.equal(store.getState().canRedo, false);
});

await test("divergence detected + reduceHeads converges", async () => {
    const a = await CommitStore.open(client, "a.graph");
    const b = await CommitStore.open(client, "a.graph");          // both at the same head
    await a.dispatch(actions.set(VIS, {instance: randomUUID()}, vdoc(1)), "a");
    await b.dispatch(actions.set(VIS, {instance: randomUUID()}, vdoc(2)), "b");   // base = old head -> diverge
    assert.equal(b.getState().diverged, true);
    await b.reduceHeads();
    assert.equal(b.getState().diverged, false);
    await a.close();
    await b.close();
});

await store.close();
console.log(`\n${"=".repeat(48)}\nPASS ${pass}  /  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
