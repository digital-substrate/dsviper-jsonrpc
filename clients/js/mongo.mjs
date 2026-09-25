// The Mongo dialect, client-side: translates a Mongo filter / update into the persona-neutral
// tagged wire forms. No transport, no runtime -- it only reshapes JSON.
//
// This DUPLICATES toTagged() from the consumer-side query package, deliberately. That
// package reaches its dialect only through its index, which pulls the native binding, and a
// HTTP client has no business loading an addon -- this module must stay importable as-is,
// browser included, with no package.json and no install step. The duplication is held in
// place by tests/clients/js/test_dialect_parity.mjs, which fails the moment the two
// translators stop producing the same tree.

/** @typedef {'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists'} WhereLeafOp */
/**
 * The tagged predicate tree the wire carries.
 * @typedef {{op: 'and' | 'or', args: (WhereNode | undefined)[]}
 *     | {op: 'not', arg: WhereNode | undefined}
 *     | {op: WhereLeafOp, path?: string, key?: string, value?: unknown}} WhereNode
 */
/** A Mongo filter: field -> condition, or $and / $or / $nor / $not. @typedef {Record<string, unknown>} MongoFilter */
/** A Mongo update document: operator -> {path: value}. @typedef {Record<string, Record<string, unknown>>} MongoUpdate */
/** A key on the wire: the instance hex, or {instance, concept?}. @typedef {string | {instance: string, concept?: string | null}} WireKey */
/**
 * The operand of one mutation verb.
 * @typedef {Object} MutationSpec
 * @property {string} attachment
 * @property {WireKey} key
 * @property {unknown} value
 * @property {string} [path]
 * @property {boolean} [recursive]
 */
/** One mutation: {verb: operand}. @typedef {Record<string, MutationSpec>} Mutation */

/** @type {Record<string, WhereLeafOp>} */
const READ_OPS = {
    $eq: "eq", $ne: "ne", $gt: "gt", $gte: "gte", $lt: "lt", $lte: "lte",
    $in: "in", $nin: "nin", $exists: "exists",
};

/** A Mongo filter -> the tagged predicate tree (or undefined for an empty filter). */
/**
 * @param {MongoFilter | undefined} filter
 * @returns {WhereNode | undefined}
 */
export function toWhere(filter) {
    if (!filter || Object.keys(filter).length === 0) return undefined;
    /** @type {WhereNode[]} */
    const conj = [];
    for (const [k, v] of Object.entries(filter)) {
        // the combinators take an array of sub-filters ($not: one sub-filter)
        if (k === "$and") conj.push({op: "and", args: /** @type {MongoFilter[]} */ (v).map(toWhere)});
        else if (k === "$or") conj.push({op: "or", args: /** @type {MongoFilter[]} */ (v).map(toWhere)});
        else if (k === "$nor") conj.push({op: "not", arg: {op: "or", args: /** @type {MongoFilter[]} */ (v).map(toWhere)}});
        else if (k === "$not") conj.push({op: "not", arg: toWhere(/** @type {MongoFilter} */ (v))});
        else conj.push(leaf(k, v));
    }
    return conj.length === 1 ? conj[0] : {op: "and", args: conj};
}

/**
 * @param {string} path
 * @returns {{key: string} | {path: string}}
 */
function slot(path) {
    return path === "_id" ? {key: "instance"} : {path};
}

/**
 * @param {string} path
 * @param {unknown} spec
 * @returns {WhereNode}
 */
function leaf(path, spec) {
    const s = slot(path);
    const isOps = spec && typeof spec === "object" && !Array.isArray(spec)
        && Object.keys(spec).some((o) => o.startsWith("$"));
    if (isOps) {
        const leaves = Object.entries(spec).map(([op, val]) => ({op: READ_OPS[op], ...s, value: val}));
        return leaves.length === 1 ? leaves[0] : {op: "and", args: leaves};
    }
    return {op: "eq", ...s, value: spec};
}

/** A Mongo update document -> the eleven-verb mutations ($set / $addToSet / $pull). */
/**
 * @param {string} attachment
 * @param {WireKey} key
 * @param {MongoUpdate} update
 * @returns {Mutation[]}
 */
export function toMutations(attachment, key, update) {
    /** @type {Mutation[]} */
    const muts = [];
    for (const [op, fields] of Object.entries(update)) {
        for (const [path, value] of Object.entries(fields)) {
            if (op === "$set") muts.push({update: {attachment, key, path, value}});
            else if (op === "$addToSet") muts.push({union_in_set: {attachment, key, path, value: arr(value)}});
            else if (op === "$pull") muts.push({subtract_in_set: {attachment, key, path, value: arr(value)}});
            else throw new Error(`unsupported update operator ${op} (try $set / $addToSet / $pull)`);
        }
    }
    return muts;
}

const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : [v]);
