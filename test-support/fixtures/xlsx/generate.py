"""Regenerate synthetic reference workbooks using openpyxl (never customer data)."""
from pathlib import Path
from datetime import datetime, date, time, timedelta
import openpyxl
from openpyxl.utils.datetime import CALENDAR_MAC_1904, CALENDAR_WINDOWS_1900
root=Path(__file__).parent
for name,epoch in [('calendar-1900.xlsx',CALENDAR_WINDOWS_1900),('calendar-1904.xlsx',CALENDAR_MAC_1904)]:
    wb=openpyxl.Workbook();wb.epoch=epoch
    sheet=wb.active;sheet.title='Resumo & dados'
    sheet.append(['Data','Ativo','Inativo','Número'])
    sheet['A3']=datetime(2026,9,21,14,30,15,123000)
    sheet['B3']=True;sheet['C3']=False;sheet['D3']=45292
    sheet['A5']=date(2024,2,29);sheet['A5'].number_format='dd/mm/yyyy'
    sheet['A7']=time(13,45);sheet['B7']=timedelta(hours=49,seconds=1)
    sheet['A9']=12;sheet['A9'].number_format='0 "days; months"'
    sheet['B9']='=SUM(D3:D3)'
    extra=wb.create_sheet('Outra');extra['A2']='fim'
    wb.save(root/name)
print('Generated synthetic XLSX references with openpyxl '+openpyxl.__version__)
