(function () {
  'use strict';

  var MAX_FILE_BYTES = 50 * 1024 * 1024;
  var PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  var PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'dSIG']);
  var EXIF_GROUPS = ['ifd0', 'ifd1', 'exif', 'gps', 'interop'];
  var EXCLUDED_XMP_GROUPS = new Set(['iptc', 'ihdr', 'jfif', 'icc', 'makerNote', 'userComment', 'thumbnail', 'hdr']);
  var VP8X_EXIF_FLAG = 0x08;
  var VP8X_XMP_FLAG = 0x04;
  var FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' };
  var FORMAT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var FORMAT_EXTENSION = { jpeg: 'jpg', png: 'png', webp: 'webp' };
  var EXIFR_OPTIONS = {
    xmp: true,
    iptc: true,
    gps: true,
    reviveValues: false,
    mergeOutput: false
  };

  var latin1Decoder = new TextDecoder('latin1');
  var utf8Decoder = new TextDecoder('utf-8');

  var el = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    preview: document.getElementById('preview'),
    previewImage: document.getElementById('preview-image'),
    fileName: document.getElementById('file-name'),
    fileDimensions: document.getElementById('file-dimensions'),
    fileSize: document.getElementById('file-size'),
    fileType: document.getElementById('file-type'),
    changeFile: document.getElementById('change-file'),
    fileStatus: document.getElementById('file-status'),
    reportStatus: document.getElementById('report-status'),
    reportEmpty: document.getElementById('report-empty'),
    reportContent: document.getElementById('report-content'),
    meta: {
      location: document.getElementById('meta-location'),
      date: document.getElementById('meta-date'),
      camera: document.getElementById('meta-camera'),
      lens: document.getElementById('meta-lens'),
      software: document.getElementById('meta-software'),
      author: document.getElementById('meta-author'),
      xmp: document.getElementById('meta-xmp'),
      iptc: document.getElementById('meta-iptc')
    },
    blockCount: document.getElementById('block-count'),
    blockList: document.getElementById('block-list'),
    blockNote: document.getElementById('block-note'),
    actionNote: document.querySelector('.action-note'),
    removeButton: document.getElementById('remove-button'),
    result: document.getElementById('result'),
    sizeBefore: document.getElementById('size-before'),
    sizeAfter: document.getElementById('size-after'),
    sizeSaved: document.getElementById('size-saved'),
    downloadLink: document.getElementById('download-link'),
    errorBanner: document.getElementById('error-banner'),
    liveRegion: document.getElementById('live-region')
  };

  var state = {
    buffer: null,
    format: null,
    blocks: [],
    textFields: {},
    parseTarget: null,
    previewUrl: '',
    cleanUrl: '',
    loadToken: 0,
    removed: false,
    busy: false
  };

  var announceTimer = 0;
  var dragDepth = 0;

  function detectFormat(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
    if (bytes.length >= 8 && PNG_SIGNATURE.every(function (value, index) {
      return bytes[index] === value;
    })) return 'png';
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    return null;
  }

  function ascii(bytes, start, length) {
    var end = Math.min(start + length, bytes.length);
    var result = '';
    for (var i = start; i < end; i++) result += String.fromCharCode(bytes[i]);
    return result;
  }

  function readU32BE(bytes, offset) {
    return bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function readU32LE(bytes, offset) {
    return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + bytes[offset + 3] * 0x1000000;
  }

  function writeU32LE(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function scanJpeg(bytes, onSegment) {
    if (bytes.length < 4) throw new Error('This JPEG is too short to contain an image.');
    var offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        throw new Error('This JPEG has an unexpected byte where a marker was expected.');
      }
      var markerOffset = offset + 1;
      while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset++;
      if (markerOffset >= bytes.length) break;
      var marker = bytes[markerOffset];
      if (marker === 0xd9) return { sosOffset: -1, eoiOffset: markerOffset + 1 };
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset = markerOffset + 1;
        continue;
      }
      if (markerOffset + 2 >= bytes.length) {
        throw new Error('This JPEG ends in the middle of a segment header.');
      }
      var length = (bytes[markerOffset + 1] << 8) | bytes[markerOffset + 2];
      if (length < 2) throw new Error('This JPEG has an invalid segment length.');
      var end = markerOffset + 1 + length;
      if (end > bytes.length) throw new Error('This JPEG is truncated.');
      if (marker === 0xda) return { sosOffset: offset, eoiOffset: -1 };
      onSegment({
        start: offset,
        markerStart: markerOffset,
        marker: marker,
        end: end,
        payloadStart: markerOffset + 3,
        payloadEnd: end
      });
      offset = end;
    }
    return { sosOffset: -1, eoiOffset: -1 };
  }

  function classifyJpegSegment(bytes, segment) {
    var head = ascii(bytes, segment.payloadStart, 64);
    switch (segment.marker) {
      case 0xe0:
        return {
          tag: 'APP0',
          detail: head.indexOf('JFIF') === 0 ? 'JFIF' : 'Application data',
          kind: 'jfif',
          remove: false
        };
      case 0xe1:
        if (head.indexOf('Exif') === 0) return { tag: 'APP1', detail: 'EXIF', kind: 'exif', remove: true };
        if (head.indexOf('http://ns.adobe.com/xap/1.0/') !== -1) {
          return { tag: 'APP1', detail: 'XMP', kind: 'xmp', remove: true };
        }
        if (head.indexOf('http://ns.adobe.com/xmp/extension/') !== -1) {
          return { tag: 'APP1', detail: 'XMP extension', kind: 'xmp', remove: true };
        }
        return { tag: 'APP1', detail: 'Unrecognised', kind: 'other', remove: true };
      case 0xe2:
        if (head.indexOf('ICC_PROFILE') === 0) {
          return { tag: 'APP2', detail: 'ICC profile', kind: 'icc', remove: false };
        }
        if (head.indexOf('MPF') === 0) {
          return { tag: 'APP2', detail: 'MPF index', kind: 'mpf', remove: false };
        }
        return { tag: 'APP2', detail: 'Vendor data', kind: 'other', remove: true };
      case 0xed:
        return {
          tag: 'APP13',
          detail: head.indexOf('Photoshop') !== -1 ? 'Photoshop / IPTC' : 'Vendor data',
          kind: 'iptc',
          remove: true
        };
      case 0xee:
        return { tag: 'APP14', detail: 'Adobe', kind: 'adobe', remove: false };
      case 0xfe:
        return { tag: 'COM', detail: 'Comment', kind: 'comment', remove: true };
      default:
        if (segment.marker >= 0xe3 && segment.marker <= 0xef) {
          return {
            tag: 'APP' + (segment.marker - 0xe0),
            detail: 'Vendor data',
            kind: 'other',
            remove: true
          };
        }
        return { tag: '', detail: '', kind: 'image', remove: false };
    }
  }

  function lastJpegEoi(bytes) {
    for (var i = bytes.length - 2; i >= 0; i--) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2;
    }
    return -1;
  }

  function inspectJpeg(bytes) {
    var blocks = [];
    var scan = scanJpeg(bytes, function (segment) {
      var info = classifyJpegSegment(bytes, segment);
      if (info.remove) {
        blocks.push({
          tag: info.tag,
          detail: info.detail,
          size: segment.end - segment.start,
          kind: info.kind
        });
      }
    });
    if (scan.sosOffset < 0) {
      throw new Error('This JPEG has no image data, so it cannot be processed.');
    }
    var eoiEnd = lastJpegEoi(bytes);
    if (eoiEnd > scan.sosOffset && eoiEnd < bytes.length) {
      blocks.push({ tag: 'Trailer', detail: 'Data after EOI', size: bytes.length - eoiEnd, kind: 'trailer' });
    }
    return { format: 'jpeg', blocks: blocks, textFields: {}, parseTarget: null };
  }

  function stripJpeg(bytes) {
    var kept = [];
    var removed = 0;
    var scan = scanJpeg(bytes, function (segment) {
      var info = classifyJpegSegment(bytes, segment);
      if (info.remove) removed++;
      else kept.push(bytes.subarray(segment.start, segment.end));
    });
    if (scan.sosOffset < 0) throw new Error('This JPEG has no image data.');
    var eoiEnd = lastJpegEoi(bytes);
    var tailEnd = eoiEnd > scan.sosOffset ? eoiEnd : bytes.length;
    var tail = bytes.subarray(scan.sosOffset, tailEnd);
    var total = 2 + tail.length;
    for (var i = 0; i < kept.length; i++) total += kept[i].length;
    var output = new Uint8Array(total);
    output[0] = 0xff;
    output[1] = 0xd8;
    var cursor = 2;
    for (var j = 0; j < kept.length; j++) {
      output.set(kept[j], cursor);
      cursor += kept[j].length;
    }
    output.set(tail, cursor);
    return { bytes: output, removed: removed };
  }

  function findNull(bytes, start, end) {
    for (var i = start; i < end; i++) {
      if (bytes[i] === 0) return i;
    }
    return -1;
  }

  function pngKeyword(bytes, start, end) {
    var zero = findNull(bytes, start, Math.min(end, start + 80));
    if (zero === -1) zero = Math.min(end, start + 80);
    return latin1Decoder.decode(bytes.subarray(start, zero));
  }

  function pngItxtText(bytes, start, end, keywordEnd) {
    if (keywordEnd + 2 >= end) return '';
    var compressed = bytes[keywordEnd + 1] === 1;
    if (compressed) return '';
    var languageEnd = findNull(bytes, keywordEnd + 3, end);
    if (languageEnd === -1) return '';
    var translatedEnd = findNull(bytes, languageEnd + 1, end);
    if (translatedEnd === -1) return '';
    var textStart = translatedEnd + 1;
    if (textStart >= end) return '';
    return utf8Decoder.decode(bytes.subarray(textStart, Math.min(end, textStart + 4096)));
  }

  function applyPngTextField(fields, keyword, value) {
    var text = value.trim();
    if (!text) return;
    var key = keyword.trim().toLowerCase();
    if ((key === 'author' || key === 'artist') && !fields.author) fields.author = text;
    else if ((key === 'software' || key === 'creator tool') && !fields.software) fields.software = text;
    else if (key === 'copyright' && !fields.copyright) fields.copyright = text;
    else if (key === 'creation time' && !fields.date) fields.date = text;
    else if (key === 'make' && !fields.make) fields.make = text;
    else if (key === 'model' && !fields.model) fields.model = text;
    else if (key === 'lens' && !fields.lens) fields.lens = text;
  }

  function inspectPng(bytes) {
    var blocks = [];
    var textFields = {};
    var offset = 8;
    var sawIend = false;
    while (offset + 12 <= bytes.length) {
      var length = readU32BE(bytes, offset);
      var type = ascii(bytes, offset + 4, 4);
      var dataStart = offset + 8;
      var end = dataStart + length + 4;
      if (end > bytes.length) throw new Error('This PNG is truncated.');
      if (PNG_METADATA_CHUNKS.has(type)) {
        var detail = '';
        var kind = 'other';
        var keyword = '';
        if (type === 'eXIf') {
          detail = 'EXIF';
          kind = 'exif';
        } else if (type === 'tIME') {
          detail = 'Timestamp';
          kind = 'time';
        } else if (type === 'dSIG') {
          detail = 'Digital signature';
        } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
          var keywordEnd = findNull(bytes, dataStart, dataStart + length);
          keyword = keywordEnd === -1 ? '' : latin1Decoder.decode(bytes.subarray(dataStart, keywordEnd));
          detail = keyword || 'Text';
          kind = /xmp/i.test(keyword) ? 'xmp' : 'text';
          if (type === 'tEXt' && keywordEnd !== -1) {
            applyPngTextField(
              textFields,
              keyword,
              latin1Decoder.decode(bytes.subarray(keywordEnd + 1, Math.min(dataStart + length, keywordEnd + 4097)))
            );
          } else if (type === 'iTXt' && keywordEnd !== -1) {
            applyPngTextField(textFields, keyword, pngItxtText(bytes, dataStart, dataStart + length, keywordEnd));
          }
        }
        blocks.push({ tag: type, detail: cleanLabel(detail), size: end - offset, kind: kind });
      }
      offset = end;
      if (type === 'IEND') {
        sawIend = true;
        break;
      }
    }
    if (!sawIend) throw new Error('This PNG is missing its IEND chunk.');
    if (offset < bytes.length) {
      blocks.push({ tag: 'Trailer', detail: 'Data after IEND', size: bytes.length - offset, kind: 'trailer' });
    }
    return { format: 'png', blocks: blocks, textFields: textFields, parseTarget: null };
  }

  function stripPng(bytes) {
    var parts = [];
    var removed = 0;
    var offset = 8;
    var sawIend = false;
    while (offset + 12 <= bytes.length) {
      var length = readU32BE(bytes, offset);
      var type = ascii(bytes, offset + 4, 4);
      var end = offset + 8 + length + 4;
      if (end > bytes.length) throw new Error('This PNG is truncated.');
      if (PNG_METADATA_CHUNKS.has(type)) removed++;
      else parts.push(bytes.subarray(offset, end));
      offset = end;
      if (type === 'IEND') {
        sawIend = true;
        break;
      }
    }
    if (!sawIend) throw new Error('This PNG is missing its IEND chunk.');
    var total = 8;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var output = new Uint8Array(total);
    output.set(PNG_SIGNATURE, 0);
    var cursor = 8;
    for (var j = 0; j < parts.length; j++) {
      output.set(parts[j], cursor);
      cursor += parts[j].length;
    }
    return { bytes: output, removed: removed };
  }

  function webpChunkEnd(bytes, offset, declaredEnd) {
    var size = readU32LE(bytes, offset + 4);
    var payloadEnd = offset + 8 + size;
    var end = payloadEnd + (size & 1);
    if (end > declaredEnd) {
      if (payloadEnd === declaredEnd) end = declaredEnd;
      else throw new Error('This WebP has a chunk that runs past the container.');
    }
    return { size: size, end: end };
  }

  function jpegApp1Segment(body) {
    var length = body.length + 2;
    if (length > 0xffff) return null;
    var segment = new Uint8Array(4 + body.length);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment[2] = (length >>> 8) & 0xff;
    segment[3] = length & 0xff;
    segment.set(body, 4);
    return segment;
  }

  function buildWebpParseTarget(exifPayload, xmpPayload) {
    var segments = [];
    if (exifPayload && exifPayload.length) {
      var exifBody;
      if (ascii(exifPayload, 0, 6) === 'Exif\u0000\u0000') {
        exifBody = exifPayload;
      } else {
        exifBody = new Uint8Array(6 + exifPayload.length);
        exifBody.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
        exifBody.set(exifPayload, 6);
      }
      var exifSegment = jpegApp1Segment(exifBody);
      if (exifSegment) segments.push(exifSegment);
    }
    if (xmpPayload && xmpPayload.length) {
      var headerText = 'http://ns.adobe.com/xap/1.0/';
      var hasHeader = ascii(xmpPayload, 0, headerText.length + 1) === headerText + '\u0000';
      var headerLength = hasHeader ? 0 : headerText.length + 1;
      var xmpBody = new Uint8Array(headerLength + xmpPayload.length);
      if (!hasHeader) {
        for (var i = 0; i < headerText.length; i++) xmpBody[i] = headerText.charCodeAt(i);
        xmpBody[headerText.length] = 0;
      }
      xmpBody.set(xmpPayload, headerLength);
      var xmpSegment = jpegApp1Segment(xmpBody);
      if (xmpSegment) segments.push(xmpSegment);
    }
    if (!segments.length) return null;
    var total = 2 + 2;
    for (var j = 0; j < segments.length; j++) total += segments[j].length;
    var output = new Uint8Array(total);
    output[0] = 0xff;
    output[1] = 0xd8;
    var cursor = 2;
    for (var k = 0; k < segments.length; k++) {
      output.set(segments[k], cursor);
      cursor += segments[k].length;
    }
    output[cursor] = 0xff;
    output[cursor + 1] = 0xd9;
    return output;
  }

  function inspectWebp(bytes) {
    var riffSize = readU32LE(bytes, 4);
    var declaredEnd = 8 + riffSize;
    if (declaredEnd < 12 || declaredEnd > bytes.length) {
      throw new Error('This WebP is truncated or has an invalid container size.');
    }
    var blocks = [];
    var exifPayload = null;
    var xmpPayload = null;
    var offset = 12;
    while (offset + 8 <= declaredEnd) {
      var type = ascii(bytes, offset, 4);
      var chunk = webpChunkEnd(bytes, offset, declaredEnd);
      if (type === 'EXIF') {
        blocks.push({ tag: 'EXIF', detail: 'EXIF data', size: chunk.end - offset, kind: 'exif' });
        exifPayload = bytes.subarray(offset + 8, offset + 8 + chunk.size);
      } else if (type === 'XMP ') {
        blocks.push({ tag: 'XMP', detail: 'XMP data', size: chunk.end - offset, kind: 'xmp' });
        xmpPayload = bytes.subarray(offset + 8, offset + 8 + chunk.size);
      }
      offset = chunk.end;
    }
    if (offset !== declaredEnd) throw new Error('This WebP contains an incomplete chunk.');
    if (declaredEnd < bytes.length) {
      blocks.push({ tag: 'Trailer', detail: 'Data after RIFF', size: bytes.length - declaredEnd, kind: 'trailer' });
    }
    return {
      format: 'webp',
      blocks: blocks,
      textFields: {},
      parseTarget: buildWebpParseTarget(exifPayload, xmpPayload)
    };
  }

  function stripWebp(bytes) {
    var riffSize = readU32LE(bytes, 4);
    var declaredEnd = 8 + riffSize;
    if (declaredEnd < 12 || declaredEnd > bytes.length) {
      throw new Error('This WebP is truncated or has an invalid container size.');
    }
    var kept = [];
    var removed = 0;
    var offset = 12;
    while (offset + 8 <= declaredEnd) {
      var type = ascii(bytes, offset, 4);
      var chunk = webpChunkEnd(bytes, offset, declaredEnd);
      if (type === 'EXIF' || type === 'XMP ') removed++;
      else kept.push({ start: offset, end: chunk.end, size: chunk.size, type: type });
      offset = chunk.end;
    }
    if (offset !== declaredEnd) throw new Error('This WebP contains an incomplete chunk.');
    var total = 12;
    for (var i = 0; i < kept.length; i++) total += kept[i].end - kept[i].start;
    var output = new Uint8Array(total);
    output.set([0x52, 0x49, 0x46, 0x46], 0);
    writeU32LE(output, 4, total - 8);
    output.set([0x57, 0x45, 0x42, 0x50], 8);
    var cursor = 12;
    for (var j = 0; j < kept.length; j++) {
      var item = kept[j];
      output.set(bytes.subarray(item.start, item.end), cursor);
      if (item.type === 'VP8X' && item.size > 0) {
        output[cursor + 8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      }
      cursor += item.end - item.start;
    }
    return { bytes: output, removed: removed };
  }

  function inspectContainer(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var format = detectFormat(bytes);
    if (!format) throw new Error('This file is not a JPEG, PNG or WebP image.');
    if (format === 'jpeg') return inspectJpeg(bytes);
    if (format === 'png') return inspectPng(bytes);
    return inspectWebp(bytes);
  }

  function stripContainer(input, format) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (format === 'jpeg') return stripJpeg(bytes);
    if (format === 'png') return stripPng(bytes);
    if (format === 'webp') return stripWebp(bytes);
    throw new Error('This image format is not supported.');
  }

  function formatBytes(value) {
    var bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB'];
    var amount = bytes / 1024;
    var index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index++;
    }
    var decimals = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return amount.toFixed(decimals) + ' ' + units[index];
  }

  function trimNumber(value) {
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(3)));
  }

  function cleanLabel(value) {
    return String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  function truncateText(value, max) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, max - 1).trimEnd() + '\u2026';
  }

  function textValue(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return formatDateObject(value);
    if (Array.isArray(value)) {
      return value.map(textValue).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
      if ('value' in value) return textValue(value.value);
      return '';
    }
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return String(value).trim();
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      var text = textValue(arguments[i]);
      if (text) return text;
    }
    return '';
  }

  function firstValue() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }

  function copyrightLine(value) {
    var text = textValue(value);
    if (!text) return '';
    return /^(\u00a9|\(c\)|copyright\b)/i.test(text) ? text : '\u00a9 ' + text;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function formatDateObject(date) {
    if (Number.isNaN(date.getTime())) return '';
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    );
  }

  function formatDateValue(value) {
    if (value instanceof Date) return formatDateObject(value);
    var raw = textValue(value);
    if (!raw) return '';
    var exifMatch = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (exifMatch) return exifMatch[1] + '-' + exifMatch[2] + '-' + exifMatch[3] + ' ' + exifMatch[4];
    return raw.replace('T', ' ');
  }

  function formatExposure(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 0 && value < 1) return '1/' + Math.round(1 / value) + ' s';
      return trimNumber(value) + ' s';
    }
    var text = textValue(value);
    if (!text) return '';
    if (/(^|\s)(s|sec|secs|seconds)$/i.test(text)) return text;
    return text + ' s';
  }

  function formatAperture(value) {
    var text = textValue(value);
    if (!text) return '';
    return /^f\//i.test(text) ? text : 'f/' + text;
  }

  function formatIso(value) {
    var text = textValue(value);
    if (!text) return '';
    return /^iso/i.test(text) ? text : 'ISO ' + text;
  }

  function formatFocalLength(value) {
    var text = textValue(value);
    if (!text) return '';
    return /mm/i.test(text) ? text : text + ' mm';
  }

  function splitMetadata(parsed) {
    if (!parsed || typeof parsed !== 'object') return { exif: {}, xmp: {}, iptc: {} };
    var isGrouped = EXIF_GROUPS.some(function (name) {
      return parsed[name] && typeof parsed[name] === 'object';
    }) || (parsed.xmp && typeof parsed.xmp === 'object') || (parsed.iptc && typeof parsed.iptc === 'object');
    if (!isGrouped) return { exif: parsed, xmp: {}, iptc: {} };

    var exif = {};
    EXIF_GROUPS.forEach(function (name) {
      if (parsed[name] && typeof parsed[name] === 'object') Object.assign(exif, parsed[name]);
    });

    var xmp = {};
    Object.keys(parsed).forEach(function (name) {
      if (EXIF_GROUPS.indexOf(name) !== -1) return;
      if (EXCLUDED_XMP_GROUPS.has(name)) return;
      var group = parsed[name];
      if (!group || typeof group !== 'object' || Array.isArray(group) || group instanceof Date) return;
      Object.assign(xmp, group);
    });

    return {
      exif: exif,
      xmp: xmp,
      iptc: parsed.iptc && typeof parsed.iptc === 'object' ? parsed.iptc : {}
    };
  }

  function collectGroupKeys(group) {
    var keys = [];
    Object.keys(group || {}).forEach(function (key) {
      if (key === 'xmlns' || key.charAt(0) === '_') return;
      if (textValue(group[key])) keys.push(key);
    });
    return keys.sort(function (a, b) {
      return a.localeCompare(b);
    });
  }

  function summarizeGroup(keys) {
    var shown = keys.slice(0, 4).join(', ');
    var extra = keys.length > 4 ? ' +' + (keys.length - 4) : '';
    return keys.length + (keys.length === 1 ? ' field' : ' fields') + ' \u00b7 ' + shown + extra;
  }

  function setRow(node, primary, secondary) {
    node.replaceChildren();
    node.classList.toggle('is-empty', !primary);
    node.classList.toggle('is-found', Boolean(primary));
    node.append(document.createTextNode(primary || '\u2014'));
    if (secondary) {
      var sub = document.createElement('span');
      sub.className = 'meta-sub';
      sub.textContent = secondary;
      node.append(sub);
    }
  }

  function renderMetadata(parsed) {
    var groups = splitMetadata(parsed);
    var exif = groups.exif;
    var xmp = groups.xmp;
    var iptc = groups.iptc;
    var textFields = state.textFields || {};

    var latitude = Number(exif.latitude);
    var longitude = Number(exif.longitude);
    var city = firstText(xmp.City, iptc.City, xmp.LocationName, iptc.LocationName);
    var location = '';
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      location = (
        Math.abs(latitude).toFixed(4) + '\u00b0 ' + (latitude >= 0 ? 'N' : 'S') + ', ' +
        Math.abs(longitude).toFixed(4) + '\u00b0 ' + (longitude >= 0 ? 'E' : 'W')
      );
      if (city) location += ' \u00b7 ' + city;
    } else {
      location = city;
    }
    var altitude = Number(exif.GPSAltitude);
    var altitudeText = location && Number.isFinite(altitude) ? 'Altitude ' + trimNumber(altitude) + ' m' : '';
    setRow(el.meta.location, location, altitudeText);

    var dateRaw = firstValue(
      exif.DateTimeOriginal,
      exif.CreateDate,
      exif.DateTimeDigitized,
      exif.ModifyDate,
      exif.DateTime,
      xmp.CreateDate,
      textFields.date
    );
    var dateText = formatDateValue(dateRaw);
    var offset = firstText(exif.OffsetTimeOriginal, exif.OffsetTime, exif.OffsetTimeDigitized);
    setRow(el.meta.date, dateText, offset ? 'UTC offset ' + offset : '');

    var make = firstText(exif.Make, textFields.make);
    var model = firstText(exif.Model, textFields.model);
    var camera = '';
    if (make && model) camera = model.toLowerCase().indexOf(make.toLowerCase()) === 0 ? model : make + ' ' + model;
    else camera = model || make;
    var settings = [];
    if (exif.ExposureTime !== null && exif.ExposureTime !== undefined) {
      var exposure = formatExposure(exif.ExposureTime);
      if (exposure) settings.push(exposure);
    }
    if (exif.FNumber !== null && exif.FNumber !== undefined) {
      var aperture = formatAperture(exif.FNumber);
      if (aperture) settings.push(aperture);
    }
    if (exif.ISO !== null && exif.ISO !== undefined) {
      var iso = formatIso(exif.ISO);
      if (iso) settings.push(iso);
    }
    if (exif.FocalLength !== null && exif.FocalLength !== undefined) {
      var focal = formatFocalLength(exif.FocalLength);
      if (focal) settings.push(focal);
    }
    setRow(el.meta.camera, camera, settings.join(' \u00b7 '));

    var lens = firstText(exif.LensModel, exif.Lens, textFields.lens);
    setRow(el.meta.lens, lens, '');

    var software = firstText(exif.Software, xmp.CreatorTool, iptc.Software, textFields.software);
    setRow(el.meta.software, software, '');

    var author = firstText(exif.Artist, xmp.creator, iptc.Byline, textFields.author);
    var copyright = firstText(textFields.copyright, xmp.rights, iptc.CopyrightNotice, exif.Copyright);
    var copyrightText = copyrightLine(copyright);
    var authorPrimary = author || copyrightText;
    var authorSub = author && copyrightText && copyrightText !== author ? copyrightText : '';
    setRow(el.meta.author, authorPrimary, authorSub);

    var xmpKeys = collectGroupKeys(xmp);
    var hasXmpBlock = state.blocks.some(function (block) { return block.kind === 'xmp'; });
    if (xmpKeys.length) {
      var xmpNote = firstText(xmp.description, xmp.title, xmp.Caption);
      setRow(el.meta.xmp, summarizeGroup(xmpKeys), truncateText(xmpNote, 140));
    } else if (hasXmpBlock) {
      setRow(el.meta.xmp, 'Block present', 'No readable fields');
    } else {
      setRow(el.meta.xmp, '', '');
    }

    var iptcKeys = collectGroupKeys(iptc);
    var hasIptcBlock = state.blocks.some(function (block) { return block.kind === 'iptc'; });
    if (iptcKeys.length) {
      var iptcNote = firstText(iptc.Caption, iptc.CaptionAbstract, iptc.Headline);
      setRow(el.meta.iptc, summarizeGroup(iptcKeys), truncateText(iptcNote, 140));
    } else if (hasIptcBlock) {
      setRow(el.meta.iptc, 'Block present', 'No readable fields');
    } else {
      setRow(el.meta.iptc, '', '');
    }
  }

  function resetMetaRows() {
    Object.keys(el.meta).forEach(function (key) {
      setRow(el.meta[key], '', '');
    });
  }

  function setStatus(node, label, modifier) {
    node.textContent = label;
    node.classList.remove('status-found', 'status-ready', 'status-clean');
    if (modifier) node.classList.add(modifier);
  }

  function announce(message) {
    window.clearTimeout(announceTimer);
    el.liveRegion.textContent = '';
    announceTimer = window.setTimeout(function () {
      el.liveRegion.textContent = message;
    }, 60);
  }

  function showError(message) {
    el.errorBanner.textContent = message;
    el.errorBanner.hidden = false;
  }

  function clearError() {
    el.errorBanner.textContent = '';
    el.errorBanner.hidden = true;
  }

  function revokeUrls() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = '';
    }
    if (state.cleanUrl) {
      URL.revokeObjectURL(state.cleanUrl);
      state.cleanUrl = '';
    }
  }

  function resetUi() {
    revokeUrls();
    state.buffer = null;
    state.format = null;
    state.blocks = [];
    state.textFields = {};
    state.parseTarget = null;
    state.removed = false;
    state.busy = false;

    el.preview.hidden = true;
    el.dropzone.hidden = false;
    el.previewImage.removeAttribute('src');
    el.previewImage.onload = null;
    el.previewImage.onerror = null;
    el.previewImage.alt = 'Preview of the selected image';
    el.fileName.textContent = '\u2014';
    el.fileName.removeAttribute('title');
    el.fileDimensions.textContent = '\u2014';
    el.fileSize.textContent = '\u2014';
    el.fileType.textContent = '\u2014';

    el.reportContent.hidden = true;
    el.reportEmpty.hidden = false;
    el.result.hidden = true;
    el.downloadLink.href = '#';
    el.sizeBefore.textContent = '\u2014';
    el.sizeAfter.textContent = '\u2014';
    el.sizeSaved.textContent = '\u2014';
    el.blockList.replaceChildren();
    el.blockCount.textContent = '0 found';
    el.blockNote.hidden = true;
    el.removeButton.disabled = true;
    el.removeButton.textContent = 'Remove metadata';
    el.actionNote.textContent = 'Image data is not re-encoded.';

    resetMetaRows();
    setStatus(el.fileStatus, 'WAITING', '');
    setStatus(el.reportStatus, 'IDLE', '');
    clearError();
  }

  function showPreview(file, token) {
    el.dropzone.hidden = true;
    el.preview.hidden = false;
    var url = URL.createObjectURL(file);
    state.previewUrl = url;
    el.previewImage.alt = 'Preview of ' + file.name;
    el.previewImage.onload = function () {
      if (token !== state.loadToken) return;
      el.fileDimensions.textContent =
        el.previewImage.naturalWidth + ' \u00d7 ' + el.previewImage.naturalHeight + ' px';
    };
    el.previewImage.onerror = function () {
      if (token !== state.loadToken) return;
      el.fileDimensions.textContent = 'Not available';
    };
    el.previewImage.src = url;
  }

  function renderFileFacts(file, format) {
    el.fileName.textContent = file.name || 'Image';
    el.fileName.title = file.name;
    el.fileDimensions.textContent = '\u2014';
    el.fileSize.textContent = formatBytes(file.size);
    el.fileType.textContent = FORMAT_LABEL[format];
  }

  function renderBlocks(blocks) {
    el.blockList.replaceChildren();
    blocks.forEach(function (block) {
      var item = document.createElement('li');
      item.className = 'block-tag';
      item.append(document.createTextNode(block.tag));
      var detail = document.createElement('span');
      detail.textContent = block.detail + ' \u00b7 ' + formatBytes(block.size);
      detail.title = detail.textContent;
      item.append(detail);
      el.blockList.append(item);
    });
    el.blockCount.textContent = blocks.length + (blocks.length === 1 ? ' block' : ' blocks');
    el.blockNote.hidden = blocks.length > 0;
  }

  function failureMessageFor(file) {
    var name = (file.name || '').toLowerCase();
    var type = (file.type || '').toLowerCase();
    if (name.endsWith('.heic') || name.endsWith('.heif') || type === 'image/heic' || type === 'image/heif') {
      return 'HEIC is not supported. Export the photo as JPEG or PNG, then try again.';
    }
    if (name.endsWith('.avif') || type === 'image/avif') {
      return 'AVIF is not supported. Export the photo as JPEG, PNG or WebP, then try again.';
    }
    return 'ExifHush reads JPEG, PNG and WebP images. This file is a different format.';
  }

  function failLoad(token, message) {
    if (token !== state.loadToken) return;
    resetUi();
    showError(message);
    setStatus(el.fileStatus, 'ERROR', 'status-found');
    setStatus(el.reportStatus, 'IDLE', '');
    announce('Could not load the file. ' + message);
  }

  async function parseMetadata(buffer) {
    if (!window.exifr || typeof window.exifr.parse !== 'function') {
      throw new Error('The metadata parser is unavailable.');
    }
    return window.exifr.parse(buffer, EXIFR_OPTIONS);
  }

  async function loadFile(file) {
    var token = ++state.loadToken;
    resetUi();
    el.fileInput.value = '';
    if (!file) return;

    if (file.size === 0) {
      failLoad(token, 'This file is empty.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      failLoad(token, 'This file is ' + formatBytes(file.size) + '. The limit is 50 MB.');
      return;
    }

    setStatus(el.fileStatus, 'READING', 'status-ready');
    setStatus(el.reportStatus, 'READING', 'status-ready');

    var buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (error) {
      failLoad(token, 'The browser could not read this file.');
      return;
    }
    if (token !== state.loadToken) return;

    var format = detectFormat(new Uint8Array(buffer));
    if (!format) {
      failLoad(token, failureMessageFor(file));
      return;
    }

    var info;
    try {
      info = inspectContainer(buffer);
    } catch (error) {
      failLoad(token, error instanceof Error ? error.message : 'This image could not be read.');
      return;
    }
    if (token !== state.loadToken) return;

    state.buffer = buffer;
    state.format = format;
    state.blocks = info.blocks;
    state.textFields = info.textFields || {};
    state.parseTarget = info.parseTarget || null;
    state.removed = false;

    renderFileFacts(file, format);
    showPreview(file, token);
    renderBlocks(info.blocks);
    el.reportEmpty.hidden = true;
    el.reportContent.hidden = false;
    setStatus(el.fileStatus, 'READY', 'status-ready');

    if (info.blocks.length) {
      setStatus(el.reportStatus, 'FOUND', 'status-found');
      el.removeButton.disabled = false;
      el.actionNote.textContent = 'Image data is not re-encoded.';
      announce(info.blocks.length + ' metadata ' + (info.blocks.length === 1 ? 'block was' : 'blocks were') + ' found in ' + file.name + '.');
    } else {
      setStatus(el.reportStatus, 'CLEAN', 'status-clean');
      el.removeButton.disabled = true;
      el.actionNote.textContent = 'No removable metadata found.';
      announce('No removable metadata found in ' + file.name + '.');
    }

    var parsed = null;
    try {
      parsed = await parseMetadata(state.parseTarget || buffer);
    } catch (error) {
      parsed = null;
    }
    if (token !== state.loadToken) return;
    renderMetadata(parsed);
  }

  function cleanFileName(name, format) {
    var raw = String(name || 'image').split(/[\\/]/).pop();
    var match = /\.([a-z0-9]+)$/i.exec(raw);
    var originalExtension = match ? match[1].toLowerCase() : '';
    var base = raw.replace(/\.[^.]+$/, '');
    base = base
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'image';
    var extension = FORMAT_EXTENSION[format];
    if (format === 'jpeg' && (originalExtension === 'jpg' || originalExtension === 'jpeg')) {
      extension = originalExtension;
    } else if (format === 'png' && originalExtension === 'png') {
      extension = 'png';
    } else if (format === 'webp' && originalExtension === 'webp') {
      extension = 'webp';
    }
    return base + '-clean.' + extension;
  }

  async function handleRemove() {
    if (!state.buffer || !state.format || !state.blocks.length || state.removed || state.busy) return;
    state.busy = true;
    el.removeButton.disabled = true;
    el.removeButton.textContent = 'Removing...';
    clearError();

    try {
      var result = stripContainer(state.buffer, state.format);
      if (!result || !result.bytes || result.bytes.length === 0) {
        throw new Error('Could not create the clean file.');
      }
      var verification = inspectContainer(result.bytes);
      if (verification.blocks.length) {
        throw new Error('Some metadata blocks were not removed. Download stopped.');
      }

      var blob = new Blob([result.bytes], { type: FORMAT_MIME[state.format] });
      if (state.cleanUrl) URL.revokeObjectURL(state.cleanUrl);
      state.cleanUrl = URL.createObjectURL(blob);
      el.downloadLink.href = state.cleanUrl;
      el.downloadLink.download = cleanFileName(el.fileName.textContent, state.format);

      var before = state.buffer.byteLength;
      var after = result.bytes.length;
      var saved = Math.max(0, before - after);
      var savedText = formatBytes(saved);
      if (saved > 0 && before > 0) {
        var percent = (saved / before) * 100;
        savedText += ' \u00b7 ' + (percent < 0.1 ? '<0.1' : percent.toFixed(1)) + '%';
      }
      el.sizeBefore.textContent = formatBytes(before);
      el.sizeAfter.textContent = formatBytes(after);
      el.sizeSaved.textContent = savedText;

      el.result.hidden = false;
      state.removed = true;
      el.removeButton.textContent = 'Metadata removed';
      setStatus(el.fileStatus, 'CLEANED', 'status-clean');
      announce(
        'Clean file created. Removed ' + formatBytes(saved) + ' of metadata. Download link available.'
      );
      el.downloadLink.focus({ preventScroll: true });
      el.result.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      });
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Metadata could not be removed from this file.');
      el.removeButton.disabled = false;
      el.removeButton.textContent = 'Remove metadata';
      announce('Metadata could not be removed.');
    } finally {
      state.busy = false;
    }
  }

  function openFilePicker() {
    el.fileInput.click();
  }

  el.fileInput.addEventListener('change', function () {
    var file = el.fileInput.files && el.fileInput.files[0];
    if (file) loadFile(file);
    else el.fileInput.value = '';
  });

  el.dropzone.addEventListener('click', openFilePicker);
  el.dropzone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  });

  el.changeFile.addEventListener('click', openFilePicker);
  el.removeButton.addEventListener('click', handleRemove);

  el.dropzone.addEventListener('dragenter', function (event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth++;
    el.dropzone.classList.add('is-dragging');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  el.dropzone.addEventListener('dragover', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  el.dropzone.addEventListener('dragleave', function (event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropzone.classList.remove('is-dragging');
  });

  el.dropzone.addEventListener('drop', function (event) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    el.dropzone.classList.remove('is-dragging');
    var transfer = event.dataTransfer;
    if (!transfer || !transfer.files || !transfer.files.length) return;
    loadFile(transfer.files[0]);
  });

  window.addEventListener('dragover', function (event) {
    event.preventDefault();
  });

  window.addEventListener('drop', function (event) {
    event.preventDefault();
  });

  window.addEventListener('pagehide', revokeUrls);

  resetUi();
})();
