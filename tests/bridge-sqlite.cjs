const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

test('node:sqlite DatabaseSync works in the current Node runtime', () => {
    const db = new DatabaseSync(':memory:');
    try {
        assert.equal(db.prepare('SELECT 42 AS value').get().value, 42);
    } finally {
        db.close();
    }
});
