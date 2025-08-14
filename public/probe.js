// Visible proof that external scripts load & run on your site
(function(){
  var bar = document.createElement('div');
  bar.textContent = '✅ Widget probe loaded from hansel-cottage.onrender.com';
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#16a34a;color:#fff;padding:6px 10px;font:14px/1.2 system-ui;z-index:2147483647;text-align:center';
  document.body.appendChild(bar);
  console.log('[hc] probe loaded');
}());
