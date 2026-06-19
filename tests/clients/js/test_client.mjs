// Integration test: the basic JS client against a REAL running gateway over HTTP.
// Orchestrated by run_test_client.sh (starts the gateway on a temp catalog, runs this, stops it).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GatewayClient, GatewayError } from "../../../clients/js/client.mjs";

const VIS = "Graph::Vertex.visualAttributes";
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n        ${e}`); }
}

const client = new GatewayClient(process.env.GATEWAY_URL || "http://127.0.0.1:8787");
console.log("gateway client integration (real HTTP)\n");

const dbs = await client.databases();
const db = await client.connect("a.graph");

await test("databases lists a.graph (show dbs)", () => assert(dbs.includes("a.graph")));
await test("connect -> session on a.graph (use)", () => assert.equal(db.database, "a.graph"));

const head = (await db.heads())[0];
await test("heads -> a head", () => assert(typeof head === "string" && head.length === 40));

await test("keys -> 5 vertices, human key {instance, concept}", async () => {
  const ks = await db.keys(head, VIS);
  assert.equal(ks.length, 5);
  assert.equal(ks[0].concept, "Graph::Vertex");
});

await test("get -> a document", async () => {
  const ks = await db.keys(head, VIS);
  const v = await db.get(head, VIS, ks[0]);
  assert.equal(typeof v.value, "number");
});

await test("query where value>=2 (tagged)", async () => {
  const rows = await db.query({ view: head, attachment: VIS, where: { op: "gte", path: "value", value: 2 } });
  assert(rows.length >= 1 && rows.every((r) => r.document.value >= 2));
});

await test("cursor (for await ... of) yields all 5", async () => {
  let n = 0;
  for await (const _row of db.cursor({ view: head, attachment: VIS, batch: 2 })) n++;
  assert.equal(n, 5);
});

await test("commit round-trip (base-pinned -> commitId -> read back)", async () => {
  const instance = randomUUID();
  const { commitId } = await db.commit(head, "from js", [
    { set: { attachment: VIS, key: { instance }, value: { value: 42, color: { red: 0, green: 0, blue: 0 } } } },
  ]);
  assert.equal(commitId.length, 40);
  const v = await db.get(commitId, VIS, { instance });
  assert.equal(v.value, 42);
});

await test("commitHeader + isAncestor", async () => {
  const h = await db.commitHeader(head);
  assert.equal(typeof h.label, "string");
  assert.equal(await db.isAncestor(await db.firstCommitId(), head), true);
});

await test("blob: createBlob / blob / unknownBlobIds (store-first)", async () => {
  const data = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString("base64");
  const blobId = await db.createBlob("uchar-4", data);
  assert.equal(blobId.length, 40);
  assert.equal((await db.blob(blobId)).data, data);
  assert.deepEqual(await db.unknownBlobIds([blobId, "00".repeat(20)]), ["00".repeat(20)]);
});

await test("error -> throws GatewayError carrying the code", async () => {
  await assert.rejects(
    () => db.keys(head, "Graph::Vertex.nope"),
    (e) => e instanceof GatewayError && e.code === "Gateway:Attachment:Unknown",
  );
});

await db.disconnect();
await test("after disconnect, ops fail (session gone)", async () => {
  await assert.rejects(() => db.keys(head, VIS), (e) => e.code === "Gateway:Session:Required");
});

console.log(`\n${"=".repeat(48)}\nPASS ${pass}  /  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
