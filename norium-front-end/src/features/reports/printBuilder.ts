export function printReportDocument(blob: Blob) {
  const url = URL.createObjectURL(blob), frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  frame.title = "Impressão do relatório";
  frame.onload = () => { window.setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); }, 800); };
  frame.src = url; document.body.appendChild(frame);
  window.setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120_000);
}
