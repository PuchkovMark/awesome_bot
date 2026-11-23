import type {CapabilitySnapshot} from '../../contracts/capabilities';
export interface ContextRoute {readonly kind:'direct_message'|'mention'|'reply'|'name';readonly mode:'normal'|'active';readonly isGroupChat:boolean}
export function formatEnvironment(input:{readonly now:number;readonly timezone:string;readonly platform:string;readonly capabilities:CapabilitySnapshot;readonly route:ContextRoute}):string {
 const {capabilities:c,route:r}=input;
 const names=['send','typing','reply','getUserName','adminInfo','membershipEvents','directMessage'] as const;
 const support=Object.fromEntries(names.map(k=>{const v=c.support[k];if(!['supported','unsupported','unknown'].includes(v))throw new TypeError('Context: invalid_environment');return [k,v];}));
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(input.platform)||!Number.isSafeInteger(input.now)||input.now<0||!['direct_message','mention','reply','name'].includes(r.kind)||!['normal','active'].includes(r.mode)||typeof r.isGroupChat!=='boolean')throw new TypeError('Context: invalid_environment');
 const formats=c.textFormats.filter(f=>['plain','markdown','html'].includes(f));
 const limit=c.maxMessageLength;
 if(limit!=='unknown'&&(!Number.isSafeInteger(limit.value)||limit.value<=0||!['utf16','unicodeCodePoints','utf8Bytes'].includes(limit.unit)))throw new TypeError('Context: invalid_environment');
 const maxMessageLength=limit==='unknown'?limit:{value:limit.value,unit:limit.unit};
 return JSON.stringify({utc:new Date(input.now).toISOString(),local:new Intl.DateTimeFormat('ru-RU',{timeZone:input.timezone,dateStyle:'short',timeStyle:'long'}).format(input.now),timezone:input.timezone,platform:input.platform,chat:r.isGroupChat?'group':'direct',mode:r.isGroupChat?r.mode:'normal',reason:r.kind,support,maxMessageLength,textFormats:[...new Set(formats)],visibility:'История неполна. После исходного сообщения могли прийти новые сообщения. Не выдумывай отсутствующие сведения.'});
}
