import test from 'node:test';
import assert from 'node:assert/strict';
import { retainedSearchPage } from './core-proto/search-page.mjs';
import { trackEmailPagination } from './web/email-pagination.mjs';

const page = items => ({search_id:'chain',query:'q',page:2,returned:items.length,partial:false,has_more:false,next_cursor:null,items});
const retain = (tool,items) => JSON.parse(retainedSearchPage(JSON.stringify(page(items)),tool));

test('retained connector searches keep the actual names, destinations and evidence used by each adapter',()=>{
  const fixtures = {
    drive_search:{id:'file',name:'Escala',mimeType:'application/vnd.google-apps.shortcut',modifiedTime:'2026-09-22',webViewLink:'https://drive.google.com/file/d/file/view',driveId:'team',shortcutDetails:{targetId:'sheet',targetMimeType:'application/vnd.google-apps.spreadsheet',targetResourceKey:'key'}},
    onedrive_search:{id:'od-file',nome:'Escala.xlsx',tipo:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',tamanho:1000,modificado:'2026-09-22',link:'https://example.sharepoint.com/escala'},
    slack_search:{user:'ana',channel:'operacao',text:'Entrega mudou para sexta.',text_truncated:false,ts:'1700000000.00001',link:'https://example.slack.com/archives/C1/p170000000000001'},
    github_search_repos:{full_name:'company/payments',description:'Payment server',stars:12,language:'JavaScript',url:'https://github.com/company/payments',private:true},
    github_search_issues:{number:17,title:'Corrigir pagamento',state:'open',author:'ana',comments:3,isPR:false,url:'https://github.com/company/payments/issues/17',repo:'company/payments'},
  };
  for(const [tool,item] of Object.entries(fixtures)){
    const result=retain(tool,[{...item,unused:'x'.repeat(25000)}]);
    assert.deepEqual(result.items,[item],tool);
    assert.equal(result.partial,false,tool);
    assert.equal(result.evidence_limited,undefined,tool);
    assert.equal(result.search_id,'chain');
    assert.equal(result.page,2);
  }
});

test('clipping descriptive text marks lost evidence but keeps exact IDs and URLs',async()=>{
  const url='https://example.slack.com/archives/C1/'+ 'x'.repeat(1100);
  const item={user:'ana',channel:'operacao',text:'a'.repeat(1400),text_truncated:false,ts:'1700000000.00001',link:url};
  const result=retain('slack_search',[item]);
  assert.equal(result.items[0].text.length,1000);
  assert.equal(result.items[0].text_truncated,true);
  assert.equal(result.items[0].link,url);
  assert.equal(result.items[0].ts,item.ts);
  assert.equal(result.evidence_limited,true);
  assert.equal(result.partial,true);
  assert.equal(result.completion_reason,'evidence_limited');
  assert.equal(result.retained_items,1);
  const again=JSON.parse(retainedSearchPage(JSON.stringify(result),'slack_search'));
  assert.deepEqual(again,result);
  const tracker=trackEmailPagination([{name:'slack_search',run:async()=>JSON.stringify(page([item]))}]);
  await tracker.tools[0].run({query:'entrega'});
  assert.equal(tracker.hasNonEmailPartial(),false);
  tracker.observeRetainedResults([{role:'tool',name:'slack_search',content:JSON.stringify(result)}]);
  assert.equal(tracker.hasNonEmailPartial(),true);
  assert.ok(tracker.nonEmailCoverage().some(row=>row.reason==='evidence_limited'));
});

test('oversize Slack page remains bounded with useful retained messages and explicit loss',()=>{
  const items=Array.from({length:20},(_,i)=>({user:'ana',channel:'operacao',text:'a'.repeat(800),text_truncated:false,ts:String(i),link:`https://example.slack.com/archives/C1/${i}`}));
  const result=retain('slack_search',items);
  assert.ok(result.items.length>0&&result.items.length<items.length);
  assert.ok(JSON.stringify(result).length<=16000);
  assert.equal(result.returned,20);
  assert.equal(result.retained_items,result.items.length);
  assert.equal(result.partial,true);
  assert.equal(result.evidence_limited,true);
  assert.deepEqual(result.items[0],items[0]);
});
