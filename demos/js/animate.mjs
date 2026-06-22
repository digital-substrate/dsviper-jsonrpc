// Live demo: animate a graph vertex from JavaScript, through the CommitStore. Open the same
// .graph file in the ge-py editor ("go live") and watch the vertex move as JS dispatches commits
// -- each step is a real commit on the CommitDatabase, driven from a browser-grade JS client.
//
//   1. GATEWAY_DB_DIR=<dir-with-your-graph> python3 server/app.py
//   2. open that .graph in ge-py, then "go live"
//   3. node demos/js/animate.mjs <database-name> [steps]
import {GatewayClient} from "../../clients/js/client.mjs";
import {CommitStore, actions} from "../../clients/js/store.mjs";

const ATT = "Graph::Vertex.render2DAttributes";
const url = process.env.GATEWAY_URL || "http://127.0.0.1:8787";
const database = process.argv[2] || "scene.graph";
const steps = Number(process.argv[3] || 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = await CommitStore.open(new GatewayClient(url), database);

const keys = await store.collection(ATT).keys();
if (keys.length === 0) {
    console.error(`no vertices in ${database} (${ATT})`);
    process.exit(1);
}
const key = keys[0];
const start = await store.collection(ATT).findOne(key);
console.log(`animating vertex ${key.instance} from ${JSON.stringify(start.position)}\n`);

for (let i = 0; i < steps; i++) {
    const x = 250 + 180 * Math.cos(i / 6);
    await store.dispatch(actions.update(ATT, key, "position.x", x), `animate ${i}`);
    process.stdout.write(`\r  step ${i + 1}/${steps}  x=${x.toFixed(1)}  head=${store.getState().head.slice(0, 8)}`);
    await sleep(120);
}

console.log("\ndone — vertex animated from JavaScript, one commit per step (watch it in ge-py)");
await store.close();
