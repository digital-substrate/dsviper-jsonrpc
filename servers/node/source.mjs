// The lazy [key, document] row source the query compiler feeds to the chain.

export function* rows(attachmentGetting, attachment, {keyPred = null, encoded = true} = {}) {
    for (const key of attachmentGetting.keys(attachment)) {
        if (keyPred && !keyPred(key)) continue;
        const document = attachmentGetting.get(attachment, key);
        if (!document.isNil()) yield [key, document.unwrap(encoded)];
    }
}
