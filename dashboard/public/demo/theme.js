(() => {
  // Keep native autofocus and transcript scrolling inside the embedded tour.
  if (parent !== window) {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function(options) {
      return focus.call(this, { ...options, preventScroll: true });
    };
    Element.prototype.scrollIntoView = function(options) {
      let container = this.parentElement;
      while (container && container !== document.body) {
        const style = getComputedStyle(container);
        if (/(auto|scroll)/.test(style.overflowY) && container.scrollHeight > container.clientHeight + 1) {
          const rect = this.getBoundingClientRect(), box = container.getBoundingClientRect();
          const opts = typeof options === 'object' ? options : { block: options === false ? 'end' : 'start' };
          let delta = rect.top - box.top;
          if (opts?.block === 'end') delta = rect.bottom - box.bottom;
          else if (opts?.block === 'center') delta -= (box.height - rect.height) / 2;
          else if (opts?.block === 'nearest') delta = rect.top < box.top ? rect.top - box.top : rect.bottom > box.bottom ? rect.bottom - box.bottom : 0;
          container.scrollTo({ top: container.scrollTop + delta, behavior: opts?.behavior || 'auto' });
          return;
        }
        container = container.parentElement;
      }
    };
  }
  let theme=new URLSearchParams(location.search).get('theme');
  if(theme!=='light'&&theme!=='dark'){try{if(parent!==window)theme=parent.document.documentElement.dataset.theme;}catch{}}
  if(theme!=='light'&&theme!=='dark')theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  document.documentElement.classList.toggle('light',theme==='light');
  document.documentElement.style.colorScheme=theme;
  // Native pages also use history directly for query tabs. Keep these changes
  // inside the static demo's hash router instead of replacing /demo/index.html.
  const entryPath=location.pathname,entrySearch=location.search;
  for(const method of ['pushState','replaceState']){
    const original=history[method].bind(history);
    history[method]=function(state,title,url){
      if(url==null)return original(state,title,url);
      const next=new URL(url,location.href);
      const rewrite=next.origin===location.origin&&(next.pathname!==entryPath||(!next.hash&&next.search!==entrySearch));
      if(!rewrite)return original(state,title,url);
      const route=(next.pathname===entryPath?(location.hash.slice(1)||'/').split('?')[0]:next.pathname)+next.search;
      const before=location.href;
      original(state,title,entryPath+entrySearch+'#'+route);
      if(before!==location.href)queueMicrotask(()=>dispatchEvent(new HashChangeEvent('hashchange',{oldURL:before,newURL:location.href})));
    };
  }
  // Older native card links include their tab query in the encoded strategy id.
  // Normalize before the app's hash subscribers read the location snapshot.
  function normalizeStrategyRoute(){
    const route=location.hash.slice(1),split=route.indexOf('?');
    if(split<0||route.slice(0,split)!=='/strategies')return;
    const query=new URLSearchParams(route.slice(split+1)),id=query.get('strategy_id')||'';
    const question=id.indexOf('?');if(question<0)return;
    query.set('strategy_id',id.slice(0,question));
    for(const [key,value] of new URLSearchParams(id.slice(question+1)))if(!query.has(key))query.set(key,value);
    history.replaceState(null,'','#/strategies?'+query.toString());
  }
  addEventListener('hashchange',normalizeStrategyRoute);normalizeStrategyRoute();
})();
