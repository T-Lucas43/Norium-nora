from pathlib import Path
import io, base64, unittest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject
from reportlab.pdfgen import canvas
from app.modules.commercial.pdf_editor import PdfEdits, apply_pdf_edits
from app.modules.commercial.pdf_export import build_commercial_pdf

class PdfEditorTest(unittest.TestCase):
    def source(self):
        data=io.BytesIO(); pdf=canvas.Canvas(data,pagesize=(600,800))
        pdf.drawString(40,750,'Original page 1'); pdf.showPage(); pdf.drawString(40,750,'Original page 2'); pdf.save()
        return data.getvalue()
    def layer(self, **patch):
        return dict(id='text-1',type='text',page=0,x=.1,y=.2,width=.6,height=.1,text='Added by editor',fontSize=20,**patch)
    def test_renders_text_at_visual_coordinates_and_keeps_original(self):
        output=apply_pdf_edits(self.source(),{'layers':[self.layer()]})
        reader=PdfReader(io.BytesIO(output)); self.assertEqual(len(reader.pages),2)
        self.assertIn('Original page 1',reader.pages[0].extract_text()); self.assertIn('Added by editor',reader.pages[0].extract_text())
        matches=[]
        reader.pages[0].extract_text(visitor_text=lambda text,cm,tm,font,size: matches.append((text,tm,size)))
        inserted=next(item for item in matches if 'Added by editor' in item[0])
        self.assertAlmostEqual(inserted[1][4],60); self.assertAlmostEqual(inserted[1][5],623)
    def test_image_and_signature_are_embedded_and_page_order_is_preserved(self):
        image=Image.new('RGBA',(100,25),(0,0,0,255)); data=io.BytesIO(); image.save(data,format='PNG')
        signature=dict(id='sig',type='signature',page=1,x=.2,y=.6,width=.4,height=.1,dataUrl='data:image/png;base64,'+base64.b64encode(data.getvalue()).decode())
        output=apply_pdf_edits(self.source(),{'layers':[signature],'pages':[{'source':1,'rotation':0},{'source':0,'rotation':0}]})
        reader=PdfReader(io.BytesIO(output)); self.assertIn('Original page 2',reader.pages[0].extract_text()); self.assertTrue(reader.pages[0].images)
    def test_validates_geometry_images_and_missing_pages(self):
        for patch in [dict(x=float('nan')),dict(width=2),dict(type='signature',dataUrl='https://example.test/private.png')]:
            with self.assertRaises(ValueError): PdfEdits.model_validate({'layers':[{**self.layer(),**patch}]})
        with self.assertRaises(ValueError): apply_pdf_edits(self.source(),{'layers':[{**self.layer(),'page':20}]})
    def test_rotated_and_cropped_pdf_match_visual_page_dimensions(self):
        reader=PdfReader(io.BytesIO(self.source())); page=reader.pages[0]; page.cropbox=RectangleObject((20,40,580,760));page.rotate(90)
        writer=PdfWriter();writer.add_page(page);buf=io.BytesIO();writer.write(buf)
        output=apply_pdf_edits(buf.getvalue(),{'layers':[self.layer()]})
        page=PdfReader(io.BytesIO(output)).pages[0]
        self.assertEqual(page.rotation,90);self.assertEqual(float(page.cropbox.width),560);self.assertEqual(float(page.cropbox.height),720)
        self.assertIn('Added by editor',page.extract_text())
    def test_highlight_keeps_requested_transparency(self):
        output = apply_pdf_edits(self.source(), {"layers":[{**self.layer(),"type":"highlight","color":"#facc15","opacity":.3}]})
        page = PdfReader(io.BytesIO(output)).pages[0]
        states = page["/Resources"]["/ExtGState"]
        self.assertTrue(any(float(state.get_object().get("/ca", 1)) == .3 for state in states.values()))
        alpha = 1
        painted = []
        for operands, operator in page.get_contents().operations:
            if operator == b"gs":
                alpha = float(states[operands[0]].get_object().get("/ca", alpha))
            if operator in {b"f", b"f*"}:
                painted.append(alpha)
        self.assertIn(.3, painted)

    def test_retains_existing_form_fields_and_appearances(self):
        source = io.BytesIO(); pdf = canvas.Canvas(source,pagesize=(600,800))
        pdf.acroForm.textfield(name="client",value="Cliente de teste",x=40,y=600,width=250,height=30)
        pdf.showPage();pdf.save()
        result = apply_pdf_edits(source.getvalue(), {"layers":[self.layer()]})
        reader = PdfReader(io.BytesIO(result))
        self.assertEqual(reader.get_fields()["client"]["/V"], "Cliente de teste")
        widget = reader.pages[0]["/Annots"][0].get_object()
        self.assertEqual(widget["/V"], "Cliente de teste")
        self.assertTrue(widget["/AP"]["/N"])
        self.assertEqual(list(widget["/Rect"]), [40,600,290,630])

    def test_proposal_export_reapplies_saved_edits_but_base_preview_omits_them(self):
        proposal={'title':'Sample proposal','contentHtml':'<p>Original proposal content.</p>','pdfEdits':{'layers':[self.layer()]}}
        edited,_=build_commercial_pdf(proposal,'proposal'); base,_=build_commercial_pdf(proposal,'proposal',False)
        self.assertIn('Added by editor',PdfReader(io.BytesIO(edited)).pages[0].extract_text())
        self.assertNotIn('Added by editor',PdfReader(io.BytesIO(base)).pages[0].extract_text())

if __name__=='__main__':unittest.main()
