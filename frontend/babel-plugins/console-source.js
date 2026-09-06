// Local replacement for babel-plugin-console-source (unmaintained, breaks on
// zero-arg console calls under Babel 8). Prepends "file (line:col)" to
// console.* calls. Skips node_modules so vendored ESM packages can transform
// under jest.

module.exports = ({ types: t }) => {
  return {
    name: 'console-source',
    visitor: {
      CallExpression(path, state) {
        const { node } = path;
        if (!node.loc) return;
        const callee = node.callee;
        if (
          !t.isMemberExpression(callee) ||
          !t.isIdentifier(callee.object, { name: 'console' }) ||
          (t.isIdentifier(callee.property) && callee.property.name === 'table')
        ) {
          return;
        }

        const opts = state.opts || {};
        const filename = state.file.opts.filename || '';
        if (filename.includes('node_modules')) return;

        let file = filename;
        if (typeof opts.resolveFile === 'function') {
          file = opts.resolveFile(file);
        } else if (opts.segments !== 0) {
          const segs = filename.split(opts.splitSegment || '/');
          file = segs.slice(Math.max(segs.length - (opts.segments || 0))).join('/');
        }

        const prefix = `${file} (${node.loc.start.line}:${node.loc.start.column})`;
        const [first] = node.arguments;

        // Zero-arg console calls would otherwise crash; just skip prefixing them.
        if (first && t.isStringLiteral(first) && first.value === prefix) return;
        if (!first) return;

        node.arguments.unshift(t.stringLiteral(prefix));
      },
    },
  };
};
