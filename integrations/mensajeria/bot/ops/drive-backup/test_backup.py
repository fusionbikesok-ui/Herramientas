import importlib.util, json, tempfile, unittest, zipfile, hashlib
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('backup',Path(__file__).with_name('backup.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

class BackupTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  self.patches=[patch.object(b,'STATE',self.root),patch.object(b,'CONFIG',self.root/'rclone.conf')]
  for p in self.patches:p.start()
  b.CONFIG.write_text('[test]\n');b.CONFIG.chmod(0o600);(self.root/'staging').mkdir()
  name='fusion-media-backup-20261015T120000Z-12345678.zip'
  self.file=self.root/'staging'/name
  content=b'test received file'
  self.mid='11111111-1111-4111-8111-111111111111'
  entry={'id':self.mid,'path':'4819/2026-10/'+self.mid+'.pdf','bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()}
  self.manifest={'files':[entry],'unavailable':[],'summary':{'registered':1}}
  with zipfile.ZipFile(self.file,'w') as z:z.writestr(entry['path'],content);z.writestr('manifest.json',json.dumps(self.manifest))
  self.pending={'name':'Mensajeria-2026-10-15-12345678.zip','local_name':name,'date_argentina':'2026-10-15','bytes':self.file.stat().st_size,'hashes':b.hashes(self.file),'summary':{'registered':1}}
  b.atomic_json(self.root/'pending.json',self.pending)
 def tearDown(self):
  for p in self.patches:p.stop()
  self.temp.cleanup()
 def metadata(self):return {'IsDir':False,'Size':self.pending['bytes'],'Hashes':{'md5':self.pending['hashes']['md5']},'ID':'drive-id'}
 def test_success_commits_only_after_cloud_verification(self):
  with patch.object(b,'rclone',side_effect=[b'',json.dumps(self.metadata()).encode()]):b.perform()
  self.assertFalse(self.file.exists());self.assertFalse((self.root/'pending.json').exists())
  ledger=b.read_json(self.root/'ledger.json',{});self.assertEqual(ledger['media'][self.mid]['archive'],self.pending['name'])
 def test_wrong_cloud_hash_preserves_pending_and_does_not_commit(self):
  meta=self.metadata();meta['Hashes']['md5']='0'*32
  with patch.object(b,'rclone',side_effect=[b'',json.dumps(meta).encode()]):
   with self.assertRaisesRegex(RuntimeError,'drive_verification_failed'):b.perform()
  self.assertTrue(self.file.exists());self.assertTrue((self.root/'pending.json').exists());self.assertFalse((self.root/'ledger.json').exists())
 def test_failed_upload_retries_same_pending_archive(self):
  with patch.object(b,'rclone',side_effect=RuntimeError('unavailable')),patch.object(b,'create_pending') as create:
   with self.assertRaisesRegex(RuntimeError,'unavailable'):b.perform()
   create.assert_not_called()
  self.assertEqual(b.read_json(self.root/'pending.json',{})['name'],self.pending['name'])
 def test_tampered_staging_file_never_uploads(self):
  with zipfile.ZipFile(self.file,'a') as z:z.writestr('unexpected.txt','tamper')
  with patch.object(b,'rclone') as remote:
   with self.assertRaisesRegex(RuntimeError,'staging_hash_mismatch'):b.perform()
   remote.assert_not_called()
 def test_existing_archive_mapping_is_preserved(self):
  previous={'archives':[{'name':'older.zip'}],'media':{'old-id':{'archive':'older.zip'}}}
  updated=b.commit(previous,self.pending,self.manifest,self.metadata())
  self.assertEqual(updated['media']['old-id']['archive'],'older.zip');self.assertEqual(len(updated['archives']),2)

if __name__=='__main__':unittest.main()
