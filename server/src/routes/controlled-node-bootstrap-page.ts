const BOOTSTRAP_DOWNLOAD_PATH = '/api/enroll/v2/download';

/**
 * Build the system-browser bridge used by copied controlled-node links.
 *
 * The bearer is read only from the URL fragment and is scrubbed before any
 * request or UI update.  XMLHttpRequest is intentional here: its native Blob
 * response can be backed by browser-managed storage, while progress events do
 * not require retaining a second JavaScript array of every received chunk.
 * The 2 GiB guard bounds browsers that nevertheless keep the Blob in memory.
 */
export function buildControlledNodeBootstrapPage(nonce: string): string {
  const script = `
(function(){
  'use strict';
  var MAX_BLOB_BYTES=2147483648;
  var downloadPath=${JSON.stringify(BOOTSTRAP_DOWNLOAD_PATH)};
  var status=document.getElementById('download-status');
  var detail=document.getElementById('download-detail');
  var progress=document.getElementById('download-progress');
  var cancelButton=document.getElementById('download-cancel');
  var ticketMatch=location.hash.slice(1).match(/(?:^|&)ticket=([A-Za-z0-9_-]{8,128})(?:&|$)/);
  var ticket=ticketMatch&&ticketMatch[1]||'';
  var fragmentScrubbed=true;
  try{history.replaceState(null,'',location.pathname+location.search)}catch(_error){fragmentScrubbed=false}

  var xhr=null;
  var objectUrl='';
  var settled=false;
  var startedAt=performance.now();
  var numberFormat=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});
  var integerFormat=new Intl.NumberFormat(undefined,{maximumFractionDigits:0});

  function formatBytes(value){
    var amount=Number.isFinite(value)&&value>0?value:0;
    var units=['B','KB','MB','GB'];
    var unitIndex=0;
    while(amount>=1000&&unitIndex<units.length-1){amount/=1000;unitIndex+=1}
    return (unitIndex===0?integerFormat:numberFormat).format(amount)+' '+units[unitIndex];
  }

  function formatRate(bytesPerSecond){
    return formatBytes(bytesPerSecond)+'/s';
  }

  function fail(message){
    if(settled)return;
    settled=true;
    status.textContent=message;
    detail.textContent='';
    progress.removeAttribute('value');
    progress.removeAttribute('aria-valuenow');
    cancelButton.disabled=true;
  }

  function safeFilename(headerValue){
    var fallback='imcodes-node-download';
    if(!headerValue)return fallback;
    var encoded=/filename\\*=UTF-8''([^;]+)/i.exec(headerValue);
    var quoted=/filename="([^"]+)"/i.exec(headerValue);
    var plain=/filename=([^;]+)/i.exec(headerValue);
    var value=encoded&&encoded[1]||quoted&&quoted[1]||plain&&plain[1]||fallback;
    if(encoded){try{value=decodeURIComponent(value)}catch(_error){return fallback}}
    value=value.replace(/[\\\\/\\u0000-\\u001f\\u007f]/g,'_').trim();
    return value&&value.length<=255?value:fallback;
  }

  function renderProgress(loaded,totalKnown,total){
    if(loaded>MAX_BLOB_BYTES){
      fail('Download is too large for this browser.');
      if(xhr)xhr.abort();
      return;
    }
    var elapsedSeconds=Math.max((performance.now()-startedAt)/1000,0.001);
    var rate=formatRate(loaded/elapsedSeconds);
    if(totalKnown&&total>0){
      if(total>MAX_BLOB_BYTES){
        fail('Download is too large for this browser.');
        if(xhr)xhr.abort();
        return;
      }
      var percent=Math.max(0,Math.min(100,Math.round(loaded/total*100)));
      progress.value=percent;
      progress.setAttribute('value',String(percent));
      progress.setAttribute('aria-valuenow',String(percent));
      detail.textContent=percent+'% · '+formatBytes(loaded)+' / '+formatBytes(total)+' · '+rate;
      return;
    }
    progress.removeAttribute('value');
    progress.removeAttribute('aria-valuenow');
    detail.textContent=formatBytes(loaded)+' · '+rate;
  }

  function cleanupObjectUrl(){
    if(!objectUrl)return;
    URL.revokeObjectURL(objectUrl);
    objectUrl='';
  }

  function saveBlob(blob,filename){
    objectUrl=URL.createObjectURL(blob);
    var anchor=document.createElement('a');
    anchor.href=objectUrl;
    anchor.download=filename;
    anchor.rel='noopener';
    anchor.hidden=true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(cleanupObjectUrl,60000);
  }

  if(!fragmentScrubbed){
    fail('This browser could not secure the download link.');
    return;
  }
  if(!ticket){
    fail('This download link is invalid.');
    return;
  }

  xhr=new XMLHttpRequest();
  xhr.open('POST',downloadPath,true);
  xhr.responseType='blob';
  xhr.withCredentials=false;
  xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded;charset=UTF-8');
  xhr.setRequestHeader('Cache-Control','no-store');
  xhr.onprogress=function(event){renderProgress(event.loaded,event.lengthComputable,event.total)};
  xhr.onerror=function(){fail('Download failed. Please try again.')};
  xhr.ontimeout=function(){fail('Download timed out. Please try again.')};
  xhr.onabort=function(){fail('Download cancelled.')};
  xhr.onload=function(){
    if(settled)return;
    if(xhr.status<200||xhr.status>=300){fail('Download failed. Please request a new link.');return}
    var blob=xhr.response;
    if(!blob||!Number.isFinite(blob.size)||blob.size<=0){fail('The download was empty.');return}
    if(blob.size>MAX_BLOB_BYTES){fail('Download is too large for this browser.');return}
    var contentLength=Number(xhr.getResponseHeader('Content-Length'));
    var hasKnownLength=Number.isFinite(contentLength)&&contentLength>0;
    renderProgress(blob.size,hasKnownLength,contentLength);
    if(settled)return;
    saveBlob(blob,safeFilename(xhr.getResponseHeader('Content-Disposition')));
    settled=true;
    status.textContent='Download complete.';
    cancelButton.disabled=true;
  };
  cancelButton.addEventListener('click',function(){if(xhr&&xhr.readyState!==XMLHttpRequest.DONE)xhr.abort()});
  addEventListener('pagehide',function(){
    if(xhr&&xhr.readyState!==XMLHttpRequest.DONE)xhr.abort();
    cleanupObjectUrl();
  },{once:true});
  var requestBody='ticket='+encodeURIComponent(ticket);
  ticket='';
  xhr.send(requestBody);
  requestBody='';
})();`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Download IM.codes node</title>
  <style nonce="${nonce}">
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101419;color:#e8edf2}
    main{width:min(34rem,calc(100vw - 2rem));padding:1.5rem;border:1px solid #33404d;border-radius:.75rem;background:#182029}
    h1{font-size:1.15rem;margin:0 0 1rem}progress{width:100%;height:.75rem}
    #download-status{margin-top:1rem;font-weight:600}#download-detail{margin-top:.4rem;color:#afbdc9;font-variant-numeric:tabular-nums}
    button{margin-top:1.25rem;padding:.5rem .8rem}button:disabled{opacity:.55}
  </style>
</head>
<body>
  <main>
    <h1>Downloading IM.codes node</h1>
    <progress id="download-progress" max="100" aria-label="Download progress"></progress>
    <div id="download-status" role="status" aria-live="polite">Preparing download…</div>
    <div id="download-detail" aria-live="polite"></div>
    <button id="download-cancel" type="button">Cancel</button>
  </main>
  <noscript>This endpoint requires JavaScript.</noscript>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
