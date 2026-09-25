import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";

export async function unlinkBuildSymlinks(directory) {
  let entries;
  try {entries=await fs.readdir(directory,{withFileTypes:true});}
  catch(error){if(error.code==="ENOENT")return;throw error;}
  for(const entry of entries){
    const child=path.join(directory,entry.name);
    if(entry.isSymbolicLink())await fs.unlink(child);
    else if(entry.isDirectory())await unlinkBuildSymlinks(child);
  }
}

/** Copy traced dependencies, never dereference a workspace node_modules link. */
export async function copyStandalone(dist, destination) {
  const standalone=path.join(dist,"standalone");
  await fs.cp(standalone,destination,{recursive:true,dereference:false,
    filter:async source=>!(await fs.lstat(source)).isSymbolicLink()});
  const files=new Map();
  async function collect(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if(entry.name==="standalone"||entry.name==="cache")continue;
      const filename=path.join(directory,entry.name);
      if(entry.isDirectory())await collect(filename);
      else if(entry.name.endsWith(".nft.json")) {
        const trace=JSON.parse(await fs.readFile(filename,"utf8"));
        for(const relative of trace.files||[]) {
          const source=path.resolve(directory,relative);
          const normalized=source.split(path.sep).join("/");
          const marker=normalized.indexOf("/node_modules/");
          if(marker<0)continue;
          const dependency=normalized.slice(marker+1);
          if(dependency.split("/").includes(".."))throw new Error("Invalid traced dependency");
          const target=path.join(destination,...dependency.split("/"));
          const real=await fs.realpath(source);
          if(!(await fs.stat(real)).isFile())throw new Error("Trace must contain files, not dependency directories");
          if(files.has(target)&&files.get(target)!==real) {
            if(!Buffer.from(await fs.readFile(files.get(target))).equals(await fs.readFile(real)))throw new Error("Conflicting traced dependency: "+dependency);
          }
          files.set(target,real);
        }
      }
    }
  }
  await collect(dist);
  // Next can stop tracing at a dependency symlink outside its tracing root.
  // Complete the trace from the real installed runtime entrypoints.
  const require=createRequire(path.join(path.resolve(dist),"package.json"));
  const {nodeFileTrace}=require("next/dist/compiled/@vercel/nft");
  const seeds=[...files.values(),require.resolve("next"),require.resolve("react"),require.resolve("react-dom/server")];
  const traced=await nodeFileTrace(seeds,{base:path.parse(path.resolve(dist)).root,processCwd:path.dirname(path.resolve(dist)),mixedModules:true});
  for(const relative of traced.fileList){
    const source=path.resolve(path.parse(path.resolve(dist)).root,relative);
    if(!(await fs.stat(source)).isFile())continue;
    const normalized=source.split(path.sep).join("/");const marker=normalized.indexOf("/node_modules/");
    if(marker<0)continue;
    files.set(path.join(destination,...normalized.slice(marker+1).split("/")),source);
  }
  for(const [target,source] of files){await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(source,target);}
  return files.size;
}
