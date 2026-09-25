// Embedded-key un-projection: runtime [instanceHex, conceptRuntimeIdHex] -> {instance, concept}.
import dsviper from '@digitalsubstrate/dsviper';

/** @import * as V from '@digitalsubstrate/dsviper' */

const {Value} = dsviper;

/** A key as the wire shows it. @typedef {{instance: string, concept: string | null}} HumanKey */

export class Unprojector {
    /** @param {V.DefinitionsInspector} inspector */
    constructor(inspector) {
        /** @type {Map<string, string>} */
        this._rid2name = new Map();
        for (const typeName of inspector.conceptTypeNames()) {
            const concept = inspector.checkConcept(typeName);
            this._rid2name.set(String(concept.runtimeId()), concept.representation());
        }
    }

    /**
     * @param {unknown} v
     * @returns {v is [string, string]}
     */
    _isKey(v) {
        return Array.isArray(v) && v.length === 2
            && v.every((x) => typeof x === 'string') && this._rid2name.has(String(v[1]));
    }

    /**
     * A key dumps to [instanceHex, conceptRuntimeIdHex]; an already-dumped pair is taken as is.
     * @param {V.ValueKey | string[]} valueKey
     * @returns {HumanKey}
     */
    key(valueKey) {
        const pair = Array.isArray(valueKey) ? valueKey : /** @type {string[]} */ (Value.dumps(valueKey, true));
        return {instance: pair[0], concept: this._rid2name.get(String(pair[1])) ?? null};
    }

    /**
     * @param {unknown} v a document as Value.dumps(_, true) renders it
     * @returns {unknown}
     */
    value(v) {
        if (this._isKey(v)) return {instance: v[0], concept: this._rid2name.get(String(v[1]))};
        if (Array.isArray(v)) return v.map((x) => this.value(x));
        if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v))
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.value(x)]));
        return v;
    }
}
