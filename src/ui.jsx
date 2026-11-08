import React from 'react';
import {ArrowRight,Check,ChevronRight,LoaderCircle,ShieldCheck,X,Inbox,Info,FileText} from 'lucide-react';
export function Button({children,onClick,variant='',icon:Icon,loading,disabled,...p}){return <button className={'btn '+variant} onClick={onClick} disabled={loading||disabled} {...p}>{loading?<LoaderCircle size={16} className="spin"/>:Icon?<Icon size={16}/>:null}{children}</button>}
export function Tag({children,tone=''}){return <span className={'tag '+tone}>{children}</span>}
export function Avatar({children,large=false,tone=''}){return <span className={'avatar '+(large?'large ':'')+tone}>{children}</span>}
export function Panel({children,className='',...props}){return <section className={'panel '+className} {...props}>{children}</section>}
export function Empty({icon:Icon=Inbox,title,description,children}){return <div className="empty"><span className="empty-icon"><Icon size={27}/></span><h3>{title}</h3><p>{description}</p>{children}</div>}
export function Field({label,children,hint}){return <label className="field"><span>{label}</span>{children}{hint?<small>{hint}</small>:null}</label>}
export function Modal({title,description,onClose,children,wide=false}){return <div className="modal-backdrop" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={title} className={'modal '+(wide?'wide':'')} onClick={e=>e.stopPropagation()}><header><div><h2>{title}</h2>{description?<p>{description}</p>:null}</div><button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={21}/></button></header>{children}</section></div>}
export function Notice({children,tone=''}){return <div className={'notice '+tone}><Info size={17}/><div>{children}</div></div>}
export function SectionTitle({title,description,children}){return <div className="section-title"><div><h2>{title}</h2>{description?<p>{description}</p>:null}</div>{children}</div>}
export const fmt=(iso)=>iso?new Date(iso).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
export const money=(fen,c='USD')=>new Intl.NumberFormat('en-US',{style:'currency',currency:c}).format((fen||0)/100);
export const names={pending:'等待执行',running:'执行中',done:'已完成',blocked:'需要处理',pending_boss:'待你批准',pending_review:'审查中',reviewing:'审查中',approved:'已批准',confirmed:'已确认',ready:'待发送',sent:'已发送',published:'已发布',superseded:'历史版本',draft:'草稿',active:'使用中',failed:'失败',creating:'创建中',paid:'已支付',contract_signed:'合同已签署',deposit_received:'定金已收到',production:'生产中',balance_received:'尾款已收到',shipped:'已发货',completed:'已完成'};
export function Status({status}){return <Tag tone={['blocked','failed'].includes(status)?'red':['pending','pending_boss','reviewing','pending_review','running','creating','production'].includes(status)?'amber':''}>{names[status]||status}</Tag>}
export function Source({id,intel,onClick}){const s=intel?.find(x=>x.id===id);return <button className="source" onClick={()=>onClick?.(s||{id})}><FileText size={12}/>{id}{s?.confidence?<span>{s.confidence.split('（')[0]} 级</span>:null}</button>}
