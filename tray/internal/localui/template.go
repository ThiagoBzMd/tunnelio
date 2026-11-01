package localui

// pageTemplate is the single HTML template (no external assets; CSP forbids them).
const pageTemplate = `<!doctype html>
<html lang="{{.P.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{{.P.Title}}</title>
<style>
:root{--bg:#fff;--fg:#141414;--muted:#6b6b6b;--line:#e6e6e6;--card:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#f2f2f2;--muted:#9a9a9a;--line:#262626;--card:#141414}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:640px;margin:0 auto;padding:20px}
header{display:flex;align-items:center;gap:14px;padding:6px 0 18px}
header b{font-size:18px}nav{margin-left:auto;display:flex;gap:6px}
nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px}nav a.on{color:var(--fg);background:var(--card);border:1px solid var(--line)}
.card{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:20px;margin-bottom:14px}
h1{font-size:22px;margin:0 0 6px}p{margin:8px 0}.muted{color:var(--muted)}.legal{margin-top:20px;font-size:12px;color:var(--muted)}.legal a{color:inherit}
.code{font:600 28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-align:center;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);margin:14px 0 6px;user-select:all}
.qr{display:block;margin:10px auto;width:min(360px,100%);border-radius:12px;background:#fff;padding:8px}
.btn{display:inline-block;padding:10px 16px;border-radius:10px;background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600;border:0;cursor:pointer;font-size:15px}
.btn.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
ol{padding-left:20px}ol li{margin:6px 0}
label{display:block;font-weight:600;margin-top:14px}input[type=text],input[type=url]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:15px;margin-top:6px}
.help{font-size:13px;color:var(--muted);margin:4px 0 0}.check{display:flex;gap:10px;align-items:flex-start;margin-top:16px}.check input{margin-top:5px}
.notice{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:12px}.err{border-color:#d33;color:#d33}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#aaa;margin-right:6px}.dot.ok{background:#2ea043}
</style>
</head>
<body><div class="wrap">
<header><svg width="30" height="30" viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" rx="230" fill="currentColor"/><g stroke="var(--bg)" stroke-width="48" stroke-linecap="round" fill="none"><line x1="534" y1="520" x2="534" y2="217"/><line x1="500" y1="500" x2="269" y2="265"/><line x1="570" y1="500" x2="732" y2="306"/><line x1="520" y1="534" x2="217" y2="534"/><line x1="600" y1="580" x2="852" y2="613"/><line x1="470" y1="655" x2="265" y2="770"/><line x1="590" y1="655" x2="855" y2="852"/></g><path d="M396 676 V545 A127 127 0 0 1 650 545 V676 Z" fill="var(--bg)"/></svg><b>Tunnelio</b>
<nav><a href="/pair?t={{.P.Token}}" class="{{if eq .P.Active "pair"}}on{{end}}">{{call .T "nav.pair"}}</a><a href="/settings?t={{.P.Token}}" class="{{if eq .P.Active "settings"}}on{{end}}">{{call .T "nav.settings"}}</a><a href="/?t={{.P.Token}}" class="{{if eq .P.Active "status"}}on{{end}}">{{call .T "nav.status"}}</a></nav></header>

{{if .P.Error}}<div class="notice err">{{.P.Error}}</div>{{end}}
{{if .P.Notice}}<div class="notice">{{.P.Notice}}</div>{{end}}

{{if eq .P.Active "pair"}}
<div class="card">
<h1>{{call .T "pair.title"}}</h1>
<p class="muted">{{call .T "pair.intro"}}</p>
{{if .P.Code}}
  <div class="code" id="code">{{.P.Code}}</div>
  {{if .P.QR}}<img class="qr" src="{{.P.QR}}" alt="QR">{{end}}
  <p class="muted" style="text-align:center">{{call .T "pair.code"}} · {{call .T "pair.expires"}} <span id="left">{{.P.ExpiresIn}}</span>s</p>
  <div class="row">
    {{if .P.OpenHere}}<a class="btn" href="{{.P.OpenHere}}">{{call .T "pair.openHere"}}</a><span class="muted" style="font-size:13px">{{call .T "pair.openHereHelp"}}</span>{{end}}
  </div>
  <div class="row">
    <form method="post" action="/pair/new"><input type="hidden" name="t" value="{{.P.Token}}"><button class="btn ghost" type="submit">{{call .T "pair.new"}}</button></form>
    <form method="post" action="/pair/cancel"><input type="hidden" name="t" value="{{.P.Token}}"><button class="btn ghost" type="submit">{{call .T "pair.cancel"}}</button></form>
  </div>
  <script>
  (function(){var s=document.getElementById('left'),n=parseInt(s.textContent,10);var i=setInterval(function(){n--;if(n<=0){clearInterval(i);location.reload();return}s.textContent=n;var m=Math.floor(n/60),r=n%60;s.textContent=m>0?(m+'m'+(r<10?'0':'')+r):n;},1000);})();
  </script>
{{else}}
  <p>{{call .T "pair.none"}}</p>
  <form method="post" action="/pair/new"><input type="hidden" name="t" value="{{.P.Token}}"><button class="btn" type="submit">{{call .T "pair.new"}}</button></form>
{{end}}
</div>
<div class="card"><ol><li>{{call .T "pair.step1"}}</li><li>{{call .T "pair.step2"}}</li><li>{{call .T "pair.step3"}}</li></ol></div>
{{end}}

{{if eq .P.Active "settings"}}
<div class="card">
<h1>{{call .T "settings.title"}}</h1>
<form method="post" action="/settings"><input type="hidden" name="t" value="{{.P.Token}}">
<label>{{call .T "settings.server"}}<input type="url" name="server_url" value="{{.P.Settings.ServerURL}}" placeholder="https://app.example.com"></label><p class="help">{{call .T "settings.serverH"}}</p>
<label>{{call .T "settings.ollama"}}<input type="url" name="ollama_url" value="{{.P.Settings.OllamaURL}}" placeholder="http://127.0.0.1:11434"></label><p class="help">{{call .T "settings.ollamaH"}}</p>
<label>{{call .T "settings.name"}}<input type="text" name="device_name" value="{{.P.Settings.DeviceName}}" maxlength="64"></label><p class="help">{{call .T "settings.nameH"}}</p>
<label class="check"><input type="checkbox" name="autostart" {{if .P.Settings.Autostart}}checked{{end}}><span>{{call .T "settings.autostart"}}<br><span class="help">{{call .T "settings.autostartH"}}</span></span></label>
<div class="row"><button class="btn" type="submit">{{call .T "settings.save"}}</button></div>
</form>
{{if .P.Folder}}<form method="post" action="/settings/folder" style="margin-top:14px"><input type="hidden" name="t" value="{{.P.Token}}"><button class="btn ghost" type="submit">{{call .T "settings.folder"}}</button></form>{{end}}
</div>
{{end}}

{{if eq .P.Active "status"}}
<div class="card">
<h1>{{call .T "status.title"}}</h1>
<p><span class="dot {{if eq .P.Status.Ollama "running"}}ok{{end}}"></span>{{call .T "status.ollama"}}: {{.P.Status.Ollama}} {{.P.Status.OllamaVersion}}</p>
<p><span class="dot {{if eq .P.Status.Relay "connected"}}ok{{end}}"></span>{{call .T "status.relay"}}: {{.P.Status.Relay}} · {{if .P.Status.Paired}}{{call .T "status.paired"}}{{else}}{{call .T "status.unpaired"}}{{end}}</p>
</div>
{{end}}
<p class="legal">{{call .T "legal"}} <a href="https://github.com/ThiagoBzMd/tunnelio/blob/main/LICENSE" target="_blank" rel="noopener">{{call .T "legal.license"}}</a> · <a href="https://github.com/ThiagoBzMd/tunnelio" target="_blank" rel="noopener">{{call .T "legal.source"}}</a></p>
</div></body></html>`
