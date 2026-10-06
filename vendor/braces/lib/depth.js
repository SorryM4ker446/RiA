'use strict';

const MAX_DEPTH = 128;
const { MAX_LENGTH } = require('./constants');
const MAX_NODES = MAX_LENGTH * 2 + 2;

// Check caller-provided ASTs iteratively before any recursive walker runs.
const validateDepth = ast => {
  const pending = [{ node: ast, depth: 0 }];
  let nodes = 1;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (depth > MAX_DEPTH) throw new SyntaxError('Brace nesting exceeds 128 levels');
    if (node && Array.isArray(node.nodes)) {
      for (const child of node.nodes) {
        if (++nodes > MAX_NODES) throw new SyntaxError('Brace AST exceeds the node limit');
        pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
};

module.exports = { MAX_DEPTH, validateDepth };
