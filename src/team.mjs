import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { snapshot } from './snapshot.mjs';

export function field(value,label) {
  if (typeof value !== 'string' || !value.trim()) throw Error(label+'不能为空');
  return value.trim();
}
export function uniqueNames(value,label) {
  if (!Array.isArray(value)) throw Error(label+'应为列表');
  const names=value.map(item=>field(item,label));
  if (new Set(names).size!==names.length) throw Error(label+'有重复项');
  return names;
}
const pluginRoot=resolve(import.meta.dirname,'..');

// Only copy explicitly named resources. The digest includes their relative names and bytes.
export function pinSkill(boss, definition) {
  const name=field(definition.name,'技能名'), version=field(definition.version,'技能版本');
  const directory=field(definition.directory,'技能目录');
  const base=directory.startsWith('@boss/')?resolve(pluginRoot,directory.slice(6)):resolve(boss.root,directory);
  const root=realpathSync(base);
  if (directory.startsWith('@boss/')) {
    const rel=relative(realpathSync(pluginRoot),root);
    if (rel==='..' || rel.startsWith('..'+(process.platform==='win32'?'\\':'/')) || isAbsolute(rel)) throw Error('插件内技能路径越界');
  }
  const resources=uniqueNames(definition.resources??[],'技能资源');
  for (const path of resources) {
    if (isAbsolute(path) || path.split(/[\\/]/).some(part=>['','..','.'].includes(part))) throw Error('技能资源须位于技能目录内');
  }
  const manifest=snapshot(root,['SKILL.md',...resources]);
  const cache=join(boss.stateDir,'skill-packs',manifest.version);
  if (!existsSync(cache)) {
    const parent=dirname(cache);
    mkdirSync(parent,{recursive:true});
    const temp=mkdtempSync(join(parent,'.writing-'));
    try {
      for (const file of manifest.files) {
        const destination=join(temp,file.path);
        mkdirSync(dirname(destination),{recursive:true});
        copyFileSync(join(root,file.path),destination);
      }
      if (snapshot(temp,manifest.files.map(f=>f.path)).version!==manifest.version) throw Error('技能文件在登记期间发生变化');
      try {renameSync(temp,cache);} catch (error) {if (!existsSync(cache)) throw error;}
    } finally {
      if (existsSync(temp) && dirname(realpathSync(temp))===realpathSync(parent)) rmSync(temp,{recursive:true,force:true});
    }
  }
  if (snapshot(cache,manifest.files.map(f=>f.path)).version!==manifest.version) throw Error('技能快照校验失败');
  return {name,version,digest:manifest.version,resources:manifest.files.map(f=>f.path)};
}
export function readPin(boss,pin) {
  const path=join(boss.stateDir,'skill-packs',pin.digest);
  if (snapshot(path,pin.resources).version!==pin.digest) throw Error('固定技能版本已损坏');
  return {name:pin.name,version:pin.version,digest:pin.digest,directory:path,instructions:readFileSync(join(path,'SKILL.md'),'utf8'),resources:pin.resources};
}
export function selectPins(profile,names) {
  return names.map(name=>{
    const pin=profile?.skills.find(item=>item.name===name);
    if (!pin) throw Error('员工尚未配置技能 '+name);
    return pin;
  });
}
export function deliveryEvidence(value) {
  if (value===undefined) return undefined;
  const result={artifact:field(value.artifact,'实际产物'),validation:field(value.validation,'实际验证'),remaining:field(value.remaining,'剩余事项')};
  if (value.skillUse!==undefined) {
    if (!Array.isArray(value.skillUse)) throw Error('技能使用证据应为列表');
    result.skillUse=value.skillUse.map(item=>{
      if (!['used','unused'].includes(item.status)) throw Error('技能使用状态无效');
      return {name:field(item.name,'技能名'),status:item.status,evidence:field(item.evidence,'使用依据或未用原因')};
    });
    uniqueNames(result.skillUse.map(item=>item.name),'使用证据中的技能');
  }
  return result;
}
export function jobNotes(job) {
  const lines=[];
  if (job.incoming) {
    const prior=job.incoming;
    lines.push('上游交接（'+job.fromJob+'，来自 '+prior.from+'）：'+prior.artifact,
      '已验证：'+prior.validation,'剩余：'+prior.remaining,'原始回执：'+prior.sourceRef);
  }
  if (job.handoff) lines.push('验收动作：'+job.handoff.acceptance,'交付给：'+job.handoff.to,'预期产物：'+job.handoff.output);
  if (job.skills?.length) {
    lines.push('在原聊天用 boss_read_skill（CLI 为 read-skill）按任务 ID 和技能名读取固定版本，再使用返回的资料。');
    for (const pin of job.skills) lines.push(pin.name+' '+pin.version+' · '+pin.digest.slice(0,12));
  }
  for (const check of job.regressions??[]) lines.push('回归 '+check.id+'：'+check.scenario+'；预期：'+check.expected);
  return lines.length?'\n\n'+lines.join('\n'):'';
}
export function stableRecord(collection,row) {
  const old=collection.find(item=>item.id===row.id);
  if (old && Object.keys(row).some(key=>JSON.stringify(old[key])!==JSON.stringify(row[key]))) throw Error('同一 ID 的内容冲突');
  if (!old) collection.push(row);
  return old??row;
}
