// The Mongo dialect is written twice on purpose: once in clients/js/mongo.mjs, which must
// stay importable with no install step (browser included), and once in the query package,
// which the servers evaluate. Two writings of one dialect drift unless something compares
// them — this does, on the only thing that matters: the tree they produce.
//
// Needs the query package as a sibling checkout (see CONTRIBUTING.md). No server, no HTTP.
import assert from "node:assert/strict";

import {toWhere} from "../../../clients/js/mongo.mjs";
import {toTagged} from "../../../../dsviper-node-query/src/tagged.mjs";

const FILTERS = [
    {},
    {value: 2},
    {value: {$gte: 2}},
    {_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301"},
    {value: {$gt: 1, $lt: 5}},
    {value: {$ne: 0}},
    {name: {$in: ["a", "b"]}},
    {name: {$nin: ["a"]}},
    {color: {$exists: true}},
    {color: {$exists: false}},
    {"color.red": {$gt: 0.25}},
    {"color.red": {$lte: 1}, value: 3},
    {$and: [{a: 1}, {b: 2}]},
    {$or: [{a: 1}, {b: 2}]},
    {$nor: [{a: 1}, {b: 2}]},
    {$not: {a: 1}},
    {$and: [{$or: [{a: 1}, {b: 2}]}, {c: {$gte: 3}}]},
    {_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", value: {$gt: 0}},
];

// Key order is an artefact of how each side builds its literals, not part of the tree.
const norm = (x) =>
    Array.isArray(x) ? x.map(norm)
        : (x !== null && typeof x === "object")
            ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])]))
            : x;

let pass = 0, fail = 0;
console.log("dialect parity: clients/js/mongo.mjs vs the query package's toTagged\n");

for (const filter of FILTERS) {
    const label = JSON.stringify(filter);
    try {
        // An empty filter has no tree to send; the client says so with undefined, the
        // package with an empty conjunction. Both mean "no constraint".
        const wire = toWhere(filter);
        const expected = Object.keys(filter).length === 0 ? undefined : norm(toTagged(filter));
        assert.deepEqual(norm(wire), expected);
        pass++;
        console.log(`  ✓ ${label}`);
    } catch (e) {
        fail++;
        console.log(`  ✗ ${label}\n        ${e}`);
    }
}

console.log(`\n${"=".repeat(48)}\nPASS ${pass}  /  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
