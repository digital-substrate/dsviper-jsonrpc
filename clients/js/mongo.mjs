// The Mongo dialect, client-side: translates a Mongo filter / update into the persona-neutral
// tagged wire forms. No transport, no runtime -- it only reshapes JSON.

const READ_OPS = {
  $eq: "eq", $ne: "ne", $gt: "gt", $gte: "gte", $lt: "lt", $lte: "lte",
  $in: "in", $nin: "nin", $exists: "exists",
};

/** A Mongo filter -> the tagged predicate tree (or undefined for an empty filter). */
export function toWhere(filter) {
  if (!filter || Object.keys(filter).length === 0) return undefined;
  const conj = [];
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$and") conj.push({ op: "and", args: v.map(toWhere) });
    else if (k === "$or") conj.push({ op: "or", args: v.map(toWhere) });
    else if (k === "$nor") conj.push({ op: "not", arg: { op: "or", args: v.map(toWhere) } });
    else if (k === "$not") conj.push({ op: "not", arg: toWhere(v) });
    else conj.push(leaf(k, v));
  }
  return conj.length === 1 ? conj[0] : { op: "and", args: conj };
}

function slot(path) {
  return path === "_id" ? { key: "instance" } : { path };
}

function leaf(path, spec) {
  const s = slot(path);
  const isOps = spec && typeof spec === "object" && !Array.isArray(spec)
    && Object.keys(spec).some((o) => o.startsWith("$"));
  if (isOps) {
    const leaves = Object.entries(spec).map(([op, val]) => ({ op: READ_OPS[op], ...s, value: val }));
    return leaves.length === 1 ? leaves[0] : { op: "and", args: leaves };
  }
  return { op: "eq", ...s, value: spec };
}

/** A Mongo update document -> the eleven-verb mutations ($set / $addToSet / $pull). */
export function toMutations(attachment, key, update) {
  const muts = [];
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields)) {
      if (op === "$set") muts.push({ update: { attachment, key, path, value } });
      else if (op === "$addToSet") muts.push({ union_in_set: { attachment, key, path, value: arr(value) } });
      else if (op === "$pull") muts.push({ subtract_in_set: { attachment, key, path, value: arr(value) } });
      else throw new Error(`unsupported update operator ${op} (try $set / $addToSet / $pull)`);
    }
  }
  return muts;
}

const arr = (v) => (Array.isArray(v) ? v : [v]);
