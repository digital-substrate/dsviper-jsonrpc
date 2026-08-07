"""The lazy (key, document) row source the query compiler feeds to py-linq."""


def rows(ag, attachment, *, key_pred=None, encoded=True):
    for key in ag.keys(attachment):
        if key_pred is not None and not key_pred(key):
            continue
        doc = ag.get(attachment, key)
        if not doc.is_nil():
            yield key, doc.unwrap(encoded=encoded)
