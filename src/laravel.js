// Rewrites the two `__DIR__.'/../...'` requires in Laravel's public/index.php
// so they resolve correctly when public/ is deployed to a different remote
// root than the rest of the app (e.g. shared hosting where public_html is
// separate from the app directory).
function patchIndexPhpPaths(content, relPathToAppRoot) {
  return content.replace(
    /__DIR__\.(['"])\/\.\.\/(vendor\/autoload\.php|bootstrap\/app\.php)\1/g,
    (match, quote, target) => `__DIR__.${quote}/${relPathToAppRoot}/${target}${quote}`
  );
}

module.exports = { patchIndexPhpPaths };
