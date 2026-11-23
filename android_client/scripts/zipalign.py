#!/usr/bin/env python3
"""
Автономный скрипт 4-byte выравнивания APK (zipalign.py) на Python 3.14.
Обеспечивает строгое выравнивание данных несжатых файлов (STORED, method 0)
по границе 4 байт в соответствии со спецификацией Android APK.
"""

import sys
import struct

ALIGNMENT = 4

def align_apk(input_path, output_path, alignment=ALIGNMENT):
    """
    Побайтово перепаковывает APK с выравниванием несжатых записей по границе alignment байт,
    сохраняя оригинальные заголовки aapt2.
    """
    with open(input_path, 'rb') as in_f, open(output_path, 'wb') as out_f:
        # Находим EOCD в конце файла
        in_f.seek(0, 2)
        file_size = in_f.tell()
        
        # Ищем сигнатуру EOCD 0x06054b50 в последних 65КБ
        search_len = min(file_size, 65536 + 22)
        in_f.seek(file_size - search_len)
        buf = in_f.read(search_len)
        eocd_pos = buf.rfind(b'\x50\x4b\x05\x06')
        if eocd_pos == -1:
            raise ValueError("Не найден End of Central Directory в APK файле")
        
        eocd_offset = file_size - search_len + eocd_pos
        in_f.seek(eocd_offset)
        eocd_raw = in_f.read(22)
        sig, disk_no, cd_disk, disk_entries, total_entries, cd_size, cd_start, comment_len = struct.unpack('<IHHHHIIH', eocd_raw)
        
        # Читаем все записи Central Directory из исходного файла
        in_f.seek(cd_start)
        cd_data = in_f.read(cd_size)
        
        # Парсим записи Central Directory для получения точных смещений и имен
        cd_records = []
        pos = 0
        while pos < cd_size:
            cd_sig = cd_data[pos:pos+4]
            if cd_sig != b'\x50\x4b\x01\x02':
                break
            header = cd_data[pos:pos+46]
            (c_sig, ver_made, ver_need, flags, comp_type,
             mod_time, mod_date, crc32, comp_size, uncomp_size,
             fn_len, extra_len, comm_len, disk_start, int_attr, ext_attr,
             lh_offset) = struct.unpack('<IHHHHHHIIIHHHHHII', header)
            
            fn_start = pos + 46
            fn_end = fn_start + fn_len
            extra_end = fn_end + extra_len
            comm_end = extra_end + comm_len
            
            filename = cd_data[fn_start:fn_end]
            extra = cd_data[fn_end:extra_end]
            comment = cd_data[extra_end:comm_end]
            
            cd_records.append({
                'header': header,
                'ver_made': ver_made,
                'ver_need': ver_need,
                'flags': flags,
                'comp_type': comp_type,
                'mod_time': mod_time,
                'mod_date': mod_date,
                'crc32': crc32,
                'comp_size': comp_size,
                'uncomp_size': uncomp_size,
                'fn_len': fn_len,
                'filename': filename,
                'extra': extra,
                'comment': comment,
                'int_attr': int_attr,
                'ext_attr': ext_attr,
                'lh_offset': lh_offset
            })
            pos = comm_end
        
        # Сортируем записи по их исходному положению в файле (lh_offset)
        cd_records.sort(key=lambda r: r['lh_offset'])
        
        # Переносим каждый файл в выходной поток с выравниванием
        new_cd_records = []
        for rec in cd_records:
            in_f.seek(rec['lh_offset'])
            lh_header = in_f.read(30)
            if lh_header[:4] != b'\x50\x4b\x03\x04':
                raise ValueError(f"Неверная сигнатура локального заголовка по смещению {rec['lh_offset']}")
            
            lh_fn_len = struct.unpack('<H', lh_header[26:28])[0]
            lh_extra_len = struct.unpack('<H', lh_header[28:30])[0]
            
            lh_fn = in_f.read(lh_fn_len)
            lh_extra = in_f.read(lh_extra_len)
            raw_data = in_f.read(rec['comp_size'])
            
            new_lh_offset = out_f.tell()

            # Очищаем старые теги выравнивания 0xd935
            clean_extra = bytearray()
            pos_tag = 0
            while pos_tag + 4 <= len(lh_extra):
                tag_id, tag_len = struct.unpack('<HH', lh_extra[pos_tag:pos_tag+4])
                if tag_id == 0xd935:
                    pos_tag += 4 + tag_len
                else:
                    clean_extra.extend(lh_extra[pos_tag:pos_tag+4+tag_len])
                    pos_tag += 4 + tag_len
            clean_extra = bytes(clean_extra)

            # Вычисляем выравнивание для STORED (comp_type == 0) через валидный тег 0xd935
            if rec['comp_type'] == 0:
                prelim_data_offset = new_lh_offset + 30 + lh_fn_len + len(clean_extra)
                pad_data_len = (alignment - ((prelim_data_offset + 4) % alignment)) % alignment
                align_tag = struct.pack('<HH', 0xd935, pad_data_len) + (b'\x00' * pad_data_len)
                lh_extra = clean_extra + align_tag
            else:
                lh_extra = clean_extra
            
            # Записываем обновленный локальный заголовок
            new_lh_header = lh_header[:28] + struct.pack('<H', len(lh_extra))
            out_f.write(new_lh_header)
            out_f.write(lh_fn)
            if lh_extra:
                out_f.write(lh_extra)
            
            data_offset = out_f.tell()
            if rec['comp_type'] == 0 and (data_offset % alignment != 0):
                raise RuntimeError(f"Ошибка выравнивания: смещение {data_offset} не кратно {alignment}")
            
            out_f.write(raw_data)
            
            # Обновляем метаданные для Central Directory
            rec['new_lh_offset'] = new_lh_offset
            rec['new_extra'] = lh_extra
            new_cd_records.append(rec)
        
        # Записываем Central Directory
        new_cd_start = out_f.tell()
        for rec in new_cd_records:
            fn = rec['filename']
            extra = rec['new_extra']
            comm = rec['comment']
            
            new_cd_header = struct.pack('<IHHHHHHIIIHHHHHII',
                0x02014b50,
                rec['ver_made'],
                rec['ver_need'],
                rec['flags'],
                rec['comp_type'],
                rec['mod_time'],
                rec['mod_date'],
                rec['crc32'],
                rec['comp_size'],
                rec['uncomp_size'],
                len(fn),
                len(extra),
                len(comm),
                0,
                rec['int_attr'],
                rec['ext_attr'],
                rec['new_lh_offset']
            )
            out_f.write(new_cd_header)
            out_f.write(fn)
            if extra:
                out_f.write(extra)
            if comm:
                out_f.write(comm)
        
        new_cd_size = out_f.tell() - new_cd_start
        
        # Записываем EOCD
        out_f.write(struct.pack('<IHHHHIIH',
            0x06054b50,
            0,
            0,
            len(new_cd_records),
            len(new_cd_records),
            new_cd_size,
            new_cd_start,
            0
        ))
        
    print(f"zipalign: успешно выровнено {len(new_cd_records)} записей, выходной файл: {output_path}")

def check_alignment(apk_path, alignment=ALIGNMENT):
    """
    Проверяет выравнивание несжатых записей в APK.
    """
    all_ok = True
    checked_count = 0
    with open(apk_path, 'rb') as f:
        while True:
            offset = f.tell()
            sig = f.read(4)
            if not sig or sig != b'\x50\x4b\x03\x04':
                break
            header = f.read(26)
            extract_ver, flags, comp_type, mod_time, mod_date, crc, comp_size, uncomp_size, fn_len, extra_len = struct.unpack('<HHHHHIIIHH', header)
            fn = f.read(fn_len).decode('utf-8', errors='replace')
            extra = f.read(extra_len)
            data_offset = f.tell()
            if comp_type == 0:
                checked_count += 1
                if data_offset % alignment != 0:
                    print(f"FAILED: {fn} (offset {data_offset} % {alignment} = {data_offset % alignment})")
                    all_ok = False
                else:
                    print(f"OK: {fn} (offset {data_offset})")
            f.seek(data_offset + comp_size)
    print(f"Проверено несжатых файлов: {checked_count}. Итог: {'SUCCESS' if all_ok else 'FAILURE'}")
    return all_ok

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Использование: python3 zipalign.py <input.apk> <output.apk> [alignment]")
        print("   или: python3 zipalign.py -c <input.apk> [alignment]")
        sys.exit(1)

    if sys.argv[1] == '-c':
        apk = sys.argv[2]
        align = int(sys.argv[3]) if len(sys.argv) > 3 else ALIGNMENT
        ok = check_alignment(apk, align)
        sys.exit(0 if ok else 1)
    else:
        in_apk = sys.argv[1]
        out_apk = sys.argv[2]
        align = int(sys.argv[3]) if len(sys.argv) > 3 else ALIGNMENT
        align_apk(in_apk, out_apk, align)
        sys.exit(0)
