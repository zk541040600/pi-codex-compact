const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

module.exports = async function piCodexCompactLoader(pi) {
  const moduleUrl = pathToFileURL(join(__dirname, "index.js"));
  moduleUrl.searchParams.set("reload", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mod = await import(moduleUrl.href);
  return mod.default(pi);
};
