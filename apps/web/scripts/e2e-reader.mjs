/** Real PDF/Office reader acceptance. Run from repository root after build:web + serve.
 * The selected Host workspace supplies the source (STUDYCLAW_SOURCE can select one).
 * Uses the page's injected token; renderer, mouse selection, APIs and storage are real.
 * Outputs stay in ignored verify_tmp. Test highlight is removed on completion.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.STUDYCLAW_BASE ?? 'http://127.0.0.1:8080';
const out=process.env.OUT_DIR ?? fileURLToPath(new URL('../../../verify_tmp/e2e-reader/',import.meta.url));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.STUDYCLAW_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[];
page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
let token,source,highlightId,oldProgress;
async function rpc(method,payload){const response=await fetch(`${base}/api/${method}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({payload})});const result=await response.json();assert(result.ok,JSON.stringify(result.error));return result.result;}
const pass=name=>{checks.push(name);console.log('PASS '+name);};
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes('新对话')&&!button.disabled));
 token=await page.evaluate(()=>window.__STUDYCLAW__?.token);
 const workspaces=await rpc('workspaces.list');assert(workspaces.current,'Open a test learning workspace first');
 const courseId=workspaces.current.split(/[\\/]/).pop(),files=(await rpc('courses.files',{courseId})).files;
 source=process.env.STUDYCLAW_SOURCE ?? files.find(file=>/\.pdf$/i.test(file.relative))?.relative ?? files.find(file=>/\.(docx?|pptx?)$/i.test(file.relative))?.relative;
 assert(source,'A real PDF or Office source is required');
 oldProgress=(await rpc('reading.load',{source})).progress;
 await rpc('reading.progress.save',{source,page:1,percent:0});
 await page.getByRole('button',{name:'阅读',exact:true}).click();
 await page.getByRole('button',{name:'资料列表',exact:true}).click();await page.locator(`button[title=${JSON.stringify(source)}]`).click();
 await page.getByRole('button',{name:'资料列表',exact:true}).click();
 const firstPage=page.locator('[data-pdf-page="1"]');
 await page.waitForFunction(()=>document.querySelector('[data-pdf-page="1"]')?.querySelectorAll('.textLayer span').length>20 && Boolean(document.querySelector('[data-pdf-page="1"]')?.dataset.renderedScale) && document.querySelector('[data-pdf-page="1"]').getBoundingClientRect().width>1000);
 assert((await firstPage.boundingBox()).width>1000);pass('Reading space is dominant at 1280px');
 await page.getByRole('button',{name:'标注列表',exact:true}).click();const bar=await page.getByTestId('reader-toolbar').boundingBox(),drawer=await page.getByTestId('annotation-drawer').boundingBox();assert(drawer.y>=bar.y+bar.height-1);await page.getByRole('button',{name:'标注列表',exact:true}).click();pass('Annotation drawer opens and closes without covering controls');
 await page.getByRole('combobox',{name:'缩放模式'}).selectOption('1');await page.waitForFunction(()=>document.querySelector('[data-pdf-page="1"]')?.dataset.renderedScale==='1');
 const box=await page.evaluate(()=>{const span=[...document.querySelectorAll('.textLayer span')].find(element=>element.textContent.length>30);assertSpan(span);function assertSpan(value){if(!value)throw Error('No actual selectable PDF text');}const rect=span.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};});
 await page.mouse.move(box.x+2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-2,box.y+box.height/2,{steps:12});await page.mouse.up();await page.getByTestId('selection-popover').locator('button').first().click();
 const record=(await rpc('reading.highlights.list',{source})).highlights.at(-1);highlightId=record.id;
 await page.getByRole('combobox',{name:'缩放模式'}).selectOption('2');await page.waitForFunction(()=>document.querySelector('[data-pdf-page="1"]')?.dataset.renderedScale==='2');
 const pageBox=await firstPage.boundingBox(),mark=await firstPage.locator('[data-testid=pdf-highlight-layer] div').last().boundingBox(),rect=record.rects.at(-1);
 assert(Math.abs(mark.x-pageBox.x-rect.x*pageBox.width)<2);assert(Math.abs(mark.y-pageBox.y-rect.y*pageBox.height)<2);pass('Real selection is persisted and stays aligned at 200%');
 await page.getByTestId('reader-scroller').click({position:{x:4,y:4}});await page.keyboard.press('f');await page.getByRole('button',{name:'退出专注阅读',exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('button',{name:'专注阅读',exact:true}).waitFor();pass('Focus keyboard shortcuts work');
 assert.equal(errors.length,0);await page.screenshot({path:join(out,'reader.png')});await writeFile(join(out,'report.json'),JSON.stringify({passed:true,checks,errors},null,2));
}catch(error){await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});await writeFile(join(out,'report.json'),JSON.stringify({passed:false,checks,error:String(error),errors},null,2));console.error(String(error));process.exitCode=1;}
finally{if(highlightId)await rpc('reading.highlights.remove',{source,id:highlightId});if(oldProgress)await rpc('reading.progress.save',{source,page:oldProgress.page,percent:oldProgress.percent});await browser.close();}
