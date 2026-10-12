import fs from 'node:fs';
import vm from 'node:vm';
import {describe,it,expect,vi} from 'vitest';

const script=fs.readFileSync('public/sw.js','utf8');
function worker({networkError=false,cacheError=false,cached,legacy=false,privateResponse=false}:{networkError?:boolean;cacheError?:boolean;cached?:Response;legacy?:boolean;privateResponse?:boolean}={}){
  const handlers:Record<string,(event:any)=>void>={};
  const deleted:string[]=[];const stored:string[]=[];
  const fetch=vi.fn(async()=>{if(networkError)throw new Error('Synthetic connection refused');return new Response('synthetic network',{status:200,headers:privateResponse?{'Cache-Control':'private, no-store'}:{}});});
  const caches={open:vi.fn(async(name:string)=>{if(cacheError)throw new Error('Synthetic cache unavailable');return{match:async()=>name===(legacy?'norium-public-shell-v2':'norium-public-shell-v3')?cached:undefined,put:async()=>{stored.push(name);},addAll:async()=>{}};}),keys:async()=>['norium-public-shell-v1','norium-public-shell-v2','norium-public-shell-v3','mailbox-personal-cache'],delete:async(name:string)=>{deleted.push(name);return true;}};
  vm.runInNewContext(script,{URL,Response,fetch,caches,self:{location:{origin:'https://norium.example.invalid'},addEventListener:(name:string,handler:(event:any)=>void)=>{handlers[name]=handler;},skipWaiting:async()=>{},clients:{claim:async()=>{}}}});
  async function request(path:string,{navigation=false,authorization=false}: {navigation?:boolean;authorization?:boolean}={}){
    let response:Promise<Response>|undefined;const waiting:Promise<unknown>[]=[];
    handlers.fetch({request:{url:'https://norium.example.invalid'+path,method:'GET',mode:navigation?'navigate':'cors',headers:new Headers(authorization?{Authorization:'Bearer synthetic-test'}:{})},respondWith:(promise:Promise<Response>)=>{response=promise;},waitUntil:(promise:Promise<unknown>)=>waiting.push(promise)});
    if(!response)return undefined;const result=await response;await Promise.all(waiting);return result;
  }
  return{request,fetch,stored,deleted,activate:async()=>{let waiting:Promise<unknown>|undefined;handlers.activate({waitUntil:(p:Promise<unknown>)=>{waiting=p;}});await waiting;}};
}
describe('service worker resilience',()=>{
  it('sempre devolve Response em asset sem cache e conexão recusada',async()=>{const w=worker({networkError:true});const r=await w.request('/assets/AuthScreen-abcdefgh.js');expect(r).toBeInstanceOf(Response);expect(r?.status).toBe(503);expect(r?.headers.get('Cache-Control')).toBe('no-store');});
  it('mostra documento de recuperação na navegação sem cache/rede',async()=>{const r=await worker({networkError:true}).request('/app/dashboard',{navigation:true});expect(r).toBeInstanceOf(Response);expect(r?.status).toBe(503);expect(await r?.text()).toContain('Não conseguimos conectar ao Norium');});
  it('usa shell público já disponível quando a navegação falha',async()=>{const r=await worker({networkError:true,cached:new Response('cached public shell')}).request('/app/dashboard',{navigation:true});expect(await r?.text()).toBe('cached public shell');});
  it('falha de CacheStorage não impede resposta da rede',async()=>{const w=worker({cacheError:true});const r=await w.request('/assets/index-abcdefgh.js');expect(await r?.text()).toBe('synthetic network');expect(w.fetch).toHaveBeenCalledOnce();});
  it('cache e rede indisponíveis ainda retornam Response',async()=>{const r=await worker({cacheError:true,networkError:true}).request('/assets/index-abcdefgh.css');expect(r).toBeInstanceOf(Response);expect(r?.status).toBe(503);});
  it('mantém geração anterior de asset já solicitado, sem fetch extra',async()=>{const w=worker({legacy:true,cached:new Response('previous public asset')});const r=await w.request('/assets/index-abcdefgh.js');expect(await r?.text()).toBe('previous public asset');expect(w.fetch).not.toHaveBeenCalled();});
  it('não intercepta API, env, recurso privado ou URL assinada',async()=>{const w=worker();for(const path of ['/api/auth/session-context','/env.js','/private/photo.png','/assets/index-abcdefgh.js?signature=synthetic'])expect(await w.request(path)).toBeUndefined();expect(await w.request('/assets/index-abcdefgh.js',{authorization:true})).toBeUndefined();expect(w.stored).toEqual([]);});
  it('navegação assinada não recebe shell em cache',async()=>{const r=await worker({networkError:true,cached:new Response('cached shell')}).request('/portal?token=synthetic',{navigation:true});expect(r?.status).toBe(503);expect(await r?.text()).not.toBe('cached shell');});
  it('resposta privada da rede não entra no cache',async()=>{const w=worker({privateResponse:true});expect((await w.request('/assets/index-abcdefgh.js'))?.status).toBe(200);expect(w.stored).toEqual([]);});
  it('ativação preserva cache pessoal e uma geração de código anterior',async()=>{const w=worker();await w.activate();expect(w.deleted).toEqual(['norium-public-shell-v1']);});
});
