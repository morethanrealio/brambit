import zlib from 'node:zlib';
// Independent small ZIP fixture writer; not the application's document generator.
export function zipFixture(files){
 const locals=[],central=[];let off=0;
 for(const [name,text] of Object.entries(files)){
  const nb=Buffer.from(name),data=Buffer.from(text),compressed=zlib.deflateRawSync(data);
  let crc=0xffffffff;for(const b of data){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50);lh.writeUInt16LE(20,4);lh.writeUInt16LE(8,8);lh.writeUInt32LE(crc,14);lh.writeUInt32LE(compressed.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(nb.length,26);
  locals.push(lh,nb,compressed);
  const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(8,10);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(compressed.length,20);ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(nb.length,28);ch.writeUInt32LE(off,42);central.push(ch,nb);off+=lh.length+nb.length+compressed.length;
 }
 const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(off,16);
 return Buffer.concat([...locals,dir,end]);
}
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function workbookFixture(rows,{date1904=false,styles='',sheets='<sheet name="Dados" sheetId="1" r:id="rId1"/>',rels=`<Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/>`,extra={}}={}){
 return zipFixture({
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml':`<workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr date1904="${date1904?1:0}"/><sheets>${sheets}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  'xl/styles.xml':`<styleSheet xmlns="${NS}">${styles}</styleSheet>`,
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`,...extra,
 });
}
export const stylesFixture=(formats=[])=>`<numFmts count="${formats.length}">${formats.map((f,i)=>`<numFmt numFmtId="${164+i}" formatCode="${f.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"/>`).join('')}</numFmts><cellXfs count="${formats.length+3}"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/>${formats.map((_,i)=>`<xf numFmtId="${164+i}"/>`).join('')}</cellXfs>`;
