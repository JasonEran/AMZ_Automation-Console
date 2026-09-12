import { readState, mutateState, saveTarget, saveBusiness, requestRun, reviewEvent, failure } from './store.js';
import { overview, history } from './views.js';

export async function intelligenceRequest(req,res,url,ctx) {
  const {config,stores,json,readJsonRequest,validAdminRole,requireProtectedMutation,csrfToken,sessionClaims}=ctx;
  const route=url.pathname.replace('/api/intelligence','');
  try {
    if(req.method==='GET'&&route==='')return json(res,200,{...overview(config.outDir,stores),csrf:csrfToken(req),canManage:validAdminRole(req)});
    const historical=/^\/targets\/([a-f0-9-]{36})\/history$/.exec(route);
    if(req.method==='GET'&&historical)return json(res,200,history(config.outDir,historical[1],Number(url.searchParams.get('page')||1)));
    const targetMatch=/^\/targets(?:\/([a-f0-9-]{36}))?$/.exec(route);
    const businessMatch=/^\/business\/([a-f0-9-]{36})$/.exec(route);
    const reviewMatch=/^\/events\/([a-f0-9-]{36})\/review$/.exec(route);
    const recognized=(targetMatch||businessMatch||reviewMatch||route==='/run'||route==='/settings');
    if(!recognized)throw failure('情报接口不存在',404);
    const allowed=targetMatch?(targetMatch[1]?'PUT':'POST'):businessMatch||reviewMatch||route==='/settings'?'PUT':'POST';
    if(req.method!==allowed){res.setHeader('Allow',allowed);throw failure('请求方法不支持',405);}
    if(!reviewMatch&&!validAdminRole(req))throw failure('此操作需要管理员权限',403);
    if(!requireProtectedMutation(req,res))return;
    const payload=await readJsonRequest(req,16384), actor=sessionClaims(req)?.username||'local-admin';
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw failure('请求内容格式无效');
    let result;
    if(targetMatch)result=saveTarget(config.outDir,payload,stores,actor,targetMatch[1]||null);
    if(businessMatch)result=saveBusiness(config.outDir,businessMatch[1],payload,actor);
    if(reviewMatch)result=reviewEvent(config.outDir,reviewMatch[1],payload,actor);
    if(route==='/run')result=requestRun(config.outDir,actor);
    if(route==='/settings')result=mutateState(config.outDir,state=>{
      if(payload.revision!==state.revision)throw failure('状态已更新，请刷新后保存',409);
      if(typeof payload.autoCollect!=='boolean')throw failure('自动监测开关无效');
      state.settings={autoCollect:payload.autoCollect,updatedBy:actor,updatedAt:new Date().toISOString()};return state.settings;
    });
    return json(res,route==='/run'?202:200,{ok:true,result});
  } catch(e) {return json(res,e.statusCode||500,{ok:false,error:e.statusCode?e.message:'情报服务暂时无法完成操作，请检查本平台日志'});}
}
