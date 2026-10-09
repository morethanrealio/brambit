import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {workbookFixture as book,stylesFixture as styles} from '../test-support/xlsx-fixture.mjs';
const moduleUrl=new URL(process.env.XLSX_TEST_MODULE||'../web/xlsxread.mjs',import.meta.url);
assert.equal(moduleUrl.protocol,'file:');
const {xlsxToText,xlsxCells,xlsxParts}=await import(moduleUrl);
const row=(n,cells)=>`<row r="${n}">${cells}</row>`;
const cell=(ref,value,attrs='')=>`<c r="${ref}" ${attrs}><v>${value}</v></c>`;
const content=(buf,opts)=>xlsxToText(buf,opts).text.replace(/^# Dados\n/,'');

test('boolean cells retain meaning and numeric 0/1 remain numeric',()=>{
 assert.equal(content(book(row(1,cell('A1',1,'t="b"')+cell('B1',0,'t="b"')+cell('C1',1)+cell('D1',0)))),'TRUE,FALSE,1,0');
});
test('dates use cell styles while ordinary amounts and string serials stay unchanged',()=>{
 const buf=book(row(1,cell('A1',45292,'s="1"')+cell('B1',45292)+cell('C1',45292,'s="1" t="str"')+cell('D1',45292.5,'s="2"')),{styles:styles()});
 assert.equal(content(buf),'2024-01-01,45292,45292,2024-01-01 12:00:00');
 // Targeted edit verification keeps its original raw-value contract.
 assert.equal(xlsxCells(buf,['Dados!A1'])[0].value,'45292');
 // ...plus the date the user sees, only when the format is a date.
 assert.deepEqual(xlsxCells(buf,['A1','B1','C1','D1']).map(c=>c.date),['2024-01-01',undefined,undefined,'2024-01-01']);
});
test('1904 date epoch and both sides of Excel fictitious leap day',()=>{
 assert.equal(content(book(row(1,cell('A1',0,'s="1"')+cell('B1',43830,'s="1"')),{date1904:true,styles:styles()})),'1904-01-01,2024-01-01');
 assert.equal(content(book(row(1,cell('A1',1,'s="1"')+cell('B1',59,'s="1"')+cell('C1',60,'s="1"')+cell('D1',61,'s="1"')),{styles:styles()})),'1900-01-01,1900-02-28,1900-02-29 [data fictícia do Excel],1900-03-01');
});
test('custom date formats, time fractions, durations and numeric literals',()=>{
 const formats=['dd/mm/yyyy','hh:mm:ss.000','[h]:mm:ss','0 "days; months"','0\\m','0.00E+00','[Red][$R$-416] #,##0.00','[>=1]yyyy-mm-dd;0'];
 const values=[45292,0.5000014236111111,1.5,12,12,12,12,0];
 const cells=values.map((v,i)=>cell(String.fromCharCode(65+i)+'1',v,`s="${i+3}"`)).join('');
 assert.equal(content(book(row(1,cells),{styles:styles(formats)})),'2024-01-01,12:00:00.123,36:00:00,12,12,12,12,0');
 assert.equal(content(book(row(1,cell('A1',45292,'s="3"')),{styles:styles(['[>=1]yyyy-mm-dd;0'])})),'2024-01-01');
});
test('out of range dates remain explicit; cached formulas are read without evaluation',()=>{
 const buf=book(row(1,cell('A1',-1,'s="1"')+cell('B1',1e20,'s="1"')+'<c r="C1" s="1"><f>TODAY()</f><v>45292</v></c><c r="D1"><f>1+2</f></c>'),{styles:styles()});
 assert.equal(content(buf),'[data/hora Excel inválida: -1],[data/hora Excel inválida: 100000000000000000000],2024-01-01,');
 assert.equal(xlsxParts(buf).formulas,2);assert.equal(xlsxCells(buf,['D1'])[0].value,'');
});
test('dates do not change with the host timezone',()=>{
 const buf=book(row(1,cell('A1',45292.5,'s="2"')),{styles:styles()});
 const script=`import {xlsxToText} from ${JSON.stringify(moduleUrl.href)};console.log(xlsxToText(Buffer.from(process.argv[1],'base64')).text);`;
 const outputs=['UTC','America/Sao_Paulo','Pacific/Auckland'].map(TZ=>execFileSync(process.execPath,['--input-type=module','-e',script,buf.toString('base64')],{encoding:'utf8',env:{PATH:process.env.PATH,TZ}}));
 assert(outputs.every(out=>out===outputs[0]));assert.match(outputs[0],/2024-01-01 12:00:00/);
});
test('row gaps and initial omitted rows keep original cell coordinates',()=>{
 const buf=book(row(3,cell('B3',7))+row(6,cell('A6',9)));
 assert.equal(content(buf),'\n\n,7\n\n\n9');assert.equal(xlsxToText(buf).rows,6);
 assert.equal(xlsxCells(buf,['Dados!A6'])[0].value,'9');
});
test('sparse far-away rows are bounded by preview budget and count their real extent',()=>{
 const buf=book(row(1,cell('A1',1))+row(1048576,cell('A1048576',99)));
 const preview=xlsxToText(buf,{maxRowsPerSheet:5,maxChars:100});assert.equal(preview.rows,1048576);assert.equal(preview.truncated,true);assert.equal(preview.text,'# Dados\n1\n\n\n\n');
 const tiny=xlsxToText(buf,{maxRowsPerSheet:1048576,maxChars:20});assert.equal(tiny.text.length,20);assert.equal(tiny.truncated,true);
});
test('missing row index can be inferred and malformed coordinates are rejected',()=>{
 assert.equal(content(book('<row>'+cell('A3',7)+'</row>')),'\n\n7');
 for(const xml of [row(0,''),row(1048577,''),row(1,cell('XFE1',1)),row(2,cell('A3',1)),row(2,'')+row(1,'')])assert.throws(()=>xlsxToText(book(xml)),/xlsx:/);
});
test('relationship IDs bind names and content after tabs are reordered',()=>{
 const buf=book(row(1,cell('A1',111)),{sheets:'<sheet name="Primeira" sheetId="8" r:id="b"/><sheet name="Segunda" sheetId="2" r:id="a"/>',rels:'<Relationship Id="a" Target="worksheets/sheet1.xml"/><Relationship Id="b" Target="/xl/worksheets/sheet9.xml"/>',extra:{'xl/worksheets/sheet9.xml':'<worksheet><sheetData>'+row(1,cell('A1',999))+'</sheetData></worksheet>'}});
 assert.equal(xlsxToText(buf).text,'# Primeira\n999\n\n# Segunda\n111');
 assert.equal(xlsxCells(buf,['A1','Primeira!A1','Segunda!A1'])[0].value,'999');
 assert.deepEqual(xlsxCells(buf,['Primeira!A1','Segunda!A1']).map(c=>c.value),['999','111']);
});
test('relationship targets support custom names, URI escapes and single-quoted attributes',()=>{
 const buf=book('',{sheets:"<sheet name='Dados &amp; Cia' sheetId='1' r:id='custom'/>",rels:"<Relationship Id='custom' Target='./worksheets/custom%20name.xml'/>",extra:{'xl/worksheets/custom name.xml':'<worksheet><sheetData>'+row(1,cell('A1',7))+'</sheetData></worksheet>'}});
 assert.equal(xlsxToText(buf).text,'# Dados & Cia\n7');assert.equal(xlsxCells(buf,['Dados & Cia!A1'])[0].value,'7');
});
test('missing and external sheet relationships fail instead of assigning plausible wrong names',()=>{
 for(const rels of ['', '<Relationship Id="rId1" Target="worksheets/missing.xml"/>','<Relationship Id="rId1" Target="https://example.invalid/secret" TargetMode="External"/>']){
  assert.throws(()=>xlsxToText(book(row(1,cell('A1',1)),{rels})),/xlsx:/);
 }
});
test('chart sheets and orphan worksheet parts do not shift labels or add fake tabs',()=>{
 const buf=book(row(1,cell('A1',7)),{sheets:'<sheet name="Chart" sheetId="9" r:id="chart"/><sheet name="Dados" sheetId="1" r:id="data"/>',rels:'<Relationship Id="chart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/><Relationship Id="data" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',extra:{'xl/worksheets/sheet2.xml':'<worksheet><sheetData>'+row(1,cell('A1',999))+'</sheetData></worksheet>'}});
 assert.equal(xlsxToText(buf).text,'# Dados\n7');assert.equal(xlsxToText(buf).sheets,1);
});
test('character limit remains truthful at exact boundary and across sheets',()=>{
 const buf=book(row(1,cell('A1',123)));const full=xlsxToText(buf);
 assert.equal(xlsxToText(buf,{maxChars:full.text.length}).truncated,false);
 assert.equal(xlsxToText(book('<row r="1"/>'),{maxChars:8}).truncated,false);
 assert.equal(xlsxToText(buf,{maxChars:full.text.length-1}).truncated,true);
 for(const opts of [{maxChars:0},{maxRowsPerSheet:-1},{maxRowsPerSheet:Infinity}])assert.throws(()=>xlsxToText(buf,opts),/limites/);
});

test('real openpyxl packages agree across both date systems, gaps, booleans and durations',async()=>{
 const {readFile}=await import('node:fs/promises');
 const expected='# Resumo & dados\nData,Ativo,Inativo,Número\n\n2026-09-21 14:30:15.123,TRUE,FALSE,45292\n\n2024-02-29\n\n13:45:00,49:00:01\n\n12,\n\n# Outra\n\nfim';
 for(const epoch of [1900,1904]){
  const buf=await readFile(new URL(`../test-support/fixtures/xlsx/calendar-${epoch}.xlsx`,import.meta.url));
  const result=xlsxToText(buf);assert.equal(result.text,expected);assert.equal(result.rows,11);assert.equal(result.sheets,2);assert.equal(result.truncated,false);
  assert.equal(xlsxParts(buf).formulas,1);assert.equal(xlsxCells(buf,['Outra!A2'])[0].value,'fim');
 }
});
