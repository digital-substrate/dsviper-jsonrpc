"""Embedded-key un-projection: runtime [instanceHex, conceptRuntimeIdHex] -> {instance, concept}."""
import dsviper


class Unprojector:
    def __init__(self, insp):
        self._rid2name = {}
        for tn in insp.concept_type_names():
            tc = insp.check_concept(tn)
            self._rid2name[str(tc.runtime_id())] = tc.representation()

    def _is_key(self, v):
        return (isinstance(v, (list, tuple)) and len(v) == 2
                and all(isinstance(x, str) for x in v) and str(v[1]) in self._rid2name)

    def key(self, value_key):
        pair = value_key if isinstance(value_key, (list, tuple)) else dsviper.Value.dumps(value_key, json=True)
        return {"instance": pair[0], "concept": self._rid2name.get(str(pair[1]))}

    def value(self, v):
        if self._is_key(v):
            return {"instance": v[0], "concept": self._rid2name[str(v[1])]}
        if isinstance(v, dict):
            return {k: self.value(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [self.value(x) for x in v]
        return v
