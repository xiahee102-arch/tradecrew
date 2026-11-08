export async function api(path,body){
 let response;try{response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(130000)});}catch{throw Error('无法连接本地服务，或请求等待过久。请检查启动终端，再查看任务记录。');}
 let data;try{data=await response.json();}catch{throw Error('服务没有返回有效数据，请确认8899端口运行的是完整后端。');}
 if(!response.ok){const e=Error(data.error||'请求失败');e.status=response.status;throw e;}return data;
}
export async function parseFile(file){
 if(file.size>15*1024*1024)throw Error('单个文件最多 15 MB');const buf=await file.arrayBuffer(),ext=file.name.split('.').pop().toLowerCase();let text='';
 if(ext==='pdf'){
  const pdfjs=await import('pdfjs-dist');const {default:workerUrl}=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
  const doc=await pdfjs.getDocument({data:buf.slice(0),useSystemFonts:true}).promise;
  for(let i=1;i<=Math.min(doc.numPages,50);i++){const page=await doc.getPage(i),content=await page.getTextContent();text+=content.items.map(x=>x.str).join(' ')+'\n';}
 }else if(ext==='docx'){const mammoth=await import('mammoth/mammoth.browser');text=(await mammoth.extractRawText({arrayBuffer:buf})).value;}
 else if(['xlsx','xls','csv'].includes(ext)){const xlsx=await import('xlsx');const book=xlsx.read(buf);text=book.SheetNames.map(name=>name+'\n'+xlsx.utils.sheet_to_csv(book.Sheets[name])).join('\n');}
 else if(['txt','md'].includes(ext))text=new TextDecoder().decode(buf);
 else throw Error('支持 PDF、Word (.docx)、Excel、CSV 和 TXT。图片／扫描件请粘贴经核对的文字。');
 if(!text.trim())throw Error('没有读到文字，扫描件请先转为可复制的文字再上传。');
 let binary='';const arr=new Uint8Array(buf);for(let i=0;i<arr.length;i+=8192)binary+=String.fromCharCode(...arr.subarray(i,i+8192));
 return {name:file.name,text:text.slice(0,200000),mime:file.type,file_base64:btoa(binary)};
}
