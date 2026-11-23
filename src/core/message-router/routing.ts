import type {RoutingInput,RoutingDecision} from './types.js';
import {directlyAddressesName} from './name-address.js';
import {validIncoming} from './validation.js';
export function routeMessage(input:RoutingInput):RoutingDecision {
 if(!input||typeof input!=='object')return {kind:'silence',reason:'invalid_input'};
 const {message,settings,service}=input;
 const silent=(reason:Extract<RoutingDecision,{kind:'silence'}>['reason']):RoutingDecision=>({kind:'silence',reason});
 if(!validIncoming(message)||!settings||!['silent','normal','active'].includes(settings.responseMode)||typeof settings.enabled!=='boolean')return silent('invalid_input');
 if(service){
  const participantPause=service.command.minimumRole==='member'&&service.command.action==='chat.pause';
  if(!service.allowed || (service.role==='member'&&!participantPause) || (service.command.minimumRole==='owner'&&service.role!=='owner') || (!settings.enabled&&service.role!=='owner'))return silent('forbidden');
  return {kind:'service',reason:'service'};
 }
 if(!settings.enabled)return silent('disabled');
 if(message.isBot==='unknown')return silent('sender_unknown');
 if(message.isBot)return silent('sender_bot');
 if(settings.responseMode==='silent')return silent('silent');
 if(message.isGroupChat){
  const address=message.replyAddress??(message.isReplyToBot?'bot':message.replyToMessageId!==undefined?'unknown':undefined);
  if(address==='unknown')return silent('reply_unknown');
  if(address==='other'&&(!message.isMentioned||message.soleBotMention!==true))return silent('reply_other');
 }
 const kind=!message.isGroupChat?'direct_message':message.isMentioned?'mention':message.isReplyToBot?'reply':directlyAddressesName(message.text)?'name':null;
 if(!kind)return silent('not_addressed');
 const mode=!message.isGroupChat?'normal':settings.responseMode;
 return {kind:'ordinary',reason:kind,route:{kind,mode,isGroupChat:message.isGroupChat}};
}
