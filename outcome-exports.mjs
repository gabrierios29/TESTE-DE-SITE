const winAnsi = new Map([...`€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ`].map((char, index) => [char, [128, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 142, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 158, 159][index]]))

function pdfText(value) {
  return [...String(value ?? '').normalize('NFC')].map(char => {
    const code = char.codePointAt(0)
    const byte = code >= 32 && code <= 255 ? code : winAnsi.get(char) ?? 63
    return byte === 40 || byte === 41 || byte === 92 || byte > 126 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)
  }).join('')
}

function ink(value, x, y, size, font = 'F1', color = '0.13 0.20 0.26') {
  return `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET\n`
}

function wrap(value, limit, measure = text => text.length) {
  return String(value ?? '').split(/\r?\n/).flatMap(paragraph => {
    const words = paragraph.match(/\S+/g) || ['']
    const lines = []
    let line = ''
    for (let word of words) {
      if (line && measure(`${line} ${word}`) > limit) {
        lines.push(line)
        line = ''
      }
      while (word && measure(word) > limit) {
        let cut = 1
        while (cut < word.length && measure(word.slice(0, cut + 1)) <= limit) cut++
        lines.push(word.slice(0, cut))
        word = word.slice(cut)
      }
      line = line ? `${line} ${word}` : word
    }
    if (line || !lines.length) lines.push(line)
    return lines
  })
}

function textWidth(value, size) {
  let units = 0
  for (const char of value.normalize('NFD').replace(/\p{Mark}/gu, '')) {
    if ('mwMW@%&'.includes(char)) units += 0.98
    else if (' ijlItf.:,|!\'`'.includes(char)) units += 0.36
    else if (/[A-Z]/.test(char)) units += 0.80
    else units += 0.66
  }
  return units * size
}

function pdf(pages, width = 842, height = 595, link = '') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  pages.forEach((content, i) => {
    const annotation = link ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [70 38 772 84] /A << /S /URI /URI (${pdfText(link)}) >> /Border [0 0 0] >>]` : ''
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R${annotation} >>`)
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`)
  })
  let source = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = []
  objects.forEach((item, i) => {
    offsets.push(Buffer.byteLength(source, 'latin1'))
    source += `${i + 1} 0 obj\n${item}\nendobj\n`
  })
  const xref = Buffer.byteLength(source, 'latin1')
  source += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source, 'latin1')
}

export function certificatePdf(certificate, validationUrl) {
  const c = certificate.snapshot
  const accent = '0.06 0.37 0.37'
  const start = 70
  const pages = []
  const background = `0.98 0.98 0.96 rg 0 0 842 595 re f\n${accent} rg 0 570 842 25 re f\n`
  let page = background
  let y = 517
  const end = () => {
    page += `${accent} RG 0.7 w ${start} 116 m 772 116 l S\n`
    page += ink(`Código ${certificate.code}  •  Emissão ${c.issued}`, start, 94, 11, 'F2', accent)
    wrap(validationUrl, 695, value => textWidth(value, 10)).forEach((line, index) => { page += ink(line, start, 74 - index * 12, 10) })
    pages.push(page)
  }
  const block = (value, size, font = 'F1', color) => {
    for (const line of wrap(value, 695, value => textWidth(value, size))) {
      if (y < 140) {
        end()
        page = background + ink('Complemento do certificado', start, 519, 17, 'F2', accent)
        y = 477
      }
      page += ink(line, start, y, size, font, color)
      y -= size + 5
    }
  }
  block(c.institution, 15, 'F2', accent)
  y -= 34
  block(c.heading, 33, 'F2')
  y -= 7
  block('Certificamos que', 13)
  y -= 7
  block(c.name, 25, 'F2')
  y -= 13
  block(`concluiu a capacitação ${c.title}, com carga horária de ${c.hours} h, no período de ${c.period}.`, 15)
  y -= 10
  block(`Instrutoria: ${c.instructors || 'Sem instrutor vinculado'}`, 13)
  if (c.footer) {
    y -= 12
    block(c.footer, 12)
  }
  end()
  return pdf(pages, 842, 595, validationUrl)
}

export function reportPdf(title, columns, rows) {
  const left = 42
  const right = 800
  const available = right - left
  const widths = columns.map(column => column.width || 1)
  const unit = available / widths.reduce((sum, width) => sum + width, 0)
  const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((sum, width) => sum + width * unit, 0))
  const caps = widths.map(width => width * unit - 10)
  const cellWrap = (value, i) => wrap(value, caps[i], text => textWidth(text, 9))
  const header = columns.map((column, i) => cellWrap(column.label, i))
  const headerHeight = Math.max(...header.map(lines => lines.length)) * 12 + 12
  const pages = []
  let content = ''
  let y = 0
  const begin = () => {
    content = '0.07 0.35 0.35 rg 0 582 842 13 re f\n'
    content += ink('ESCOLA DE GOVERNO  /  IMPARH', left, 547, 11, 'F2', '0.07 0.35 0.35')
    content += ink(title, left, 511, 23, 'F2')
    y = 483 - headerHeight
    content += `0.90 0.95 0.94 rg ${left} ${y} ${available} ${headerHeight} re f\n`
    header.forEach((lines, i) => lines.forEach((line, j) => { content += ink(line, xs[i] + 4, 467 - j * 12, 9, 'F2') }))
    y -= 7
  }
  const end = () => {
    content += ink(`Página ${pages.length + 1}  •  ${rows.length} registros`, left, 24, 9)
    pages.push(content)
  }
  begin()
  if (!rows.length) content += ink('Nenhum registro para os filtros informados.', left + 4, y - 12, 11)
  for (const row of rows) {
    const cells = columns.map((column, i) => cellWrap(row[column.key], i))
    const lineCount = Math.max(...cells.map(lines => lines.length))
    let index = 0
    while (index < lineCount) {
      if (y < 58) { end(); begin() }
      const count = Math.min(lineCount - index, Math.floor((y - 46) / 11))
      cells.forEach((lines, i) => lines.slice(index, index + count).forEach((line, j) => {
        content += ink(line, xs[i] + 4, y - 10 - j * 11, 9)
      }))
      y -= count * 11 + 6
      content += `0.87 0.90 0.91 RG 0.4 w ${left} ${y} m ${right} ${y} l S\n`
      index += count
    }
  }
  end()
  return pdf(pages)
}

export function reportCsv(columns, rows, { bi = false } = {}) {
  const separator = bi ? ',' : ';'
  const quote = value => {
    let s = String(value ?? '')
    if (typeof value === 'string' && /^[\s]*[=+@\-\t\r\n]/.test(s)) s = `'${s}`
    return `"${s.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + [columns.map(column => bi ? column.key : column.label), ...rows.map(row => columns.map(column => row[column.key]))].map(row => row.map(quote).join(separator)).join('\r\n') + '\r\n'
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  return crc >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

function zip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path)
    const body = Buffer.from(content)
    const checksum = crc32(body)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0021, 12)
    head.writeUInt32LE(checksum, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(body.length, 22)
    head.writeUInt16LE(name.length, 26)
    locals.push(head, name, body)
    const descriptor = Buffer.alloc(46)
    descriptor.writeUInt32LE(0x02014b50)
    descriptor.writeUInt16LE(20, 4)
    descriptor.writeUInt16LE(20, 6)
    descriptor.writeUInt16LE(0x0021, 14)
    descriptor.writeUInt32LE(checksum, 16)
    descriptor.writeUInt32LE(body.length, 20)
    descriptor.writeUInt32LE(body.length, 24)
    descriptor.writeUInt16LE(name.length, 28)
    descriptor.writeUInt32LE(offset, 42)
    central.push(descriptor, name)
    offset += head.length + name.length + body.length
  }
  const index = Buffer.concat(central)
  const tail = Buffer.alloc(22)
  tail.writeUInt32LE(0x06054b50)
  tail.writeUInt16LE(Object.keys(files).length, 8)
  tail.writeUInt16LE(Object.keys(files).length, 10)
  tail.writeUInt32LE(index.length, 12)
  tail.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, index, tail])
}

function xml(value) {
  return String(value ?? '').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function cellReference(column, row) {
  let letters = ''
  for (let index = column + 1; index; index = Math.floor((index - 1) / 26)) letters = String.fromCharCode(65 + (index - 1) % 26) + letters
  return `${letters}${row + 1}`
}

export function reportXlsx(columns, rows) {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const pack = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const data = [columns.map(column => column.label), ...rows.map(row => columns.map(column => row[column.key]))]
  const cells = data.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => {
    const ref = cellReference(j, i)
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
  }).join('')}</row>`).join('')
  const col = columns.map((column, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(14, Math.round((column.width || 1) * 20))}" customWidth="1"/>`).join('')
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${pack}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Relatório" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${pack}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${col}</cols><sheetData>${cells}</sheetData><autoFilter ref="A1:${cellReference(columns.length - 1, rows.length)}"/></worksheet>`,
  })
}
