#!/usr/bin/env node
/**
 * Pre-compiles the JSX in index.html so browsers don't have to.
 *
 * The app ships as one file and is edited as one file — that part does not
 * change. What changed is who does the compiling. index.html carries its React
 * code in a <script type="text/babel"> block, which means every device, on every
 * load, downloaded ~3 MB of babel-standalone and then transpiled ~670 KB of JSX
 * before a single pixel appeared. Measured in a headless Chromium on server-grade
 * hardware that is ~22 seconds to the login screen; on a factory tablet it is
 * worse. It is also pure waste: the answer is identical every time.
 *
 * So the deploy does it once. This script lifts the block into app.js, compiles
 * the JSX away, and points index.html at the result — no Babel on the client, no
 * transpile on the client.
 *
 * Nothing here is required for the app to work. If this script is not run,
 * index.html is still a complete, working application that compiles itself in the
 * browser exactly as before — which is also what makes the deploy step safe to
 * fail: the workflow keeps the original file and ships that instead.
 *
 * Only the JSX is compiled (preset "react"). Modern syntax the code already uses
 * — async/await, optional chaining, ?? — is left as written, because every
 * browser that can run this PWA has supported all of it since early 2020, and
 * because compiling it down would drag in a regenerator runtime the app would
 * then have to ship. Output is a plain classic script in global scope, exactly
 * like the block it replaces, in the same position on the page.
 *
 *   node build.js            compile in place
 *   node build.js --check    compile to a temp dir and verify, change nothing
 */
const fs=require("fs");
const path=require("path");
const {execFileSync}=require("child_process");
const crypto=require("crypto");

const ROOT=__dirname;
const HTML=path.join(ROOT,"index.html");
const OUT_JS=path.join(ROOT,"app.js");
const CHECK_ONLY=process.argv.includes("--check");
const OPEN='<script type="text/babel">';

function main(){
  const html=fs.readFileSync(HTML,"utf8");

  const start=html.indexOf(OPEN);
  if(start<0){
    console.log("index.html has no text/babel block — already compiled, nothing to do.");
    return 0;
  }
  const from=start+OPEN.length;
  const end=html.indexOf("</script>",from);
  if(end<0)throw new Error("unterminated <script type=\"text/babel\"> block");
  const jsx=html.slice(from,end);

  let Babel;
  try{Babel=require("@babel/standalone")}
  catch(e){throw new Error("@babel/standalone is not installed (npm i @babel/standalone)")}

  const {code}=Babel.transform(jsx,{
    presets:["react"],
    // The block is a classic script sharing one global scope — it must stay one.
    sourceType:"script",
    compact:false,
    comments:false,
    babelrc:false,
    configFile:false,
  });
  if(!code||!code.trim())throw new Error("transpile produced no output");

  // Verify before anything is replaced: a build that emits broken JavaScript must
  // fail here, not on the users' screens.
  const tmp=fs.mkdtempSync(path.join(require("os").tmpdir(),"pml-build-"));
  const probe=path.join(tmp,"app.js");
  fs.writeFileSync(probe,code);
  execFileSync(process.execPath,["--check",probe],{stdio:"pipe"});
  if(/\bregeneratorRuntime\b/.test(code))
    throw new Error("output needs regeneratorRuntime — the app does not ship one");
  if(!/React\.createElement/.test(code))
    throw new Error("output contains no React.createElement — JSX was not compiled");

  const hash=crypto.createHash("sha256").update(code).digest("hex").slice(0,8);

  // Swap the inline block for the compiled file, and drop the Babel download with
  // it — the only reason it was ever on the page was to compile that block.
  // `defer` matches the React/ReactDOM tags in <head>: deferred scripts execute
  // in document order, so React is always defined before this runs.
  let out=html.slice(0,start)+`<script defer src="./app.js?v=${hash}"></script>`+html.slice(end+"</script>".length);
  // Matched on "babel" in the src rather than on the exact CDN URL, so bumping the
  // version or swapping the host does not silently leave the 3 MB download in place.
  const babelTag=out.match(/[ \t]*<script[^>]+src="[^"]*babel[^"]*"[^>]*><\/script>\n?/i);
  if(!babelTag)throw new Error("could not find the babel-standalone script tag to remove");
  // Babel's slot in <head> becomes a preload for app.js, so its download starts
  // alongside React's instead of when the parser reaches the end of the body.
  out=out.replace(babelTag[0],`<link rel="preload" as="script" href="./app.js?v=${hash}"/>\n`);

  if(CHECK_ONLY){
    fs.writeFileSync(path.join(tmp,"index.html"),out);
    console.log(`✓ check passed — ${(jsx.length/1024).toFixed(0)} KB JSX → ${(code.length/1024).toFixed(0)} KB JS (${tmp})`);
    return 0;
  }
  fs.writeFileSync(OUT_JS,code);
  fs.writeFileSync(HTML,out);
  fs.rmSync(tmp,{recursive:true,force:true});
  console.log(`✓ compiled ${(jsx.length/1024).toFixed(0)} KB of JSX → app.js (${(code.length/1024).toFixed(0)} KB, v=${hash})`);
  console.log(`✓ index.html now loads app.js directly; babel-standalone is no longer fetched`);
  return 0;
}

try{process.exit(main())}
catch(e){
  console.error("✗ build failed: "+(e.message||e));
  console.error("  index.html is unchanged and still works on its own (it compiles in the browser).");
  process.exit(1);
}
