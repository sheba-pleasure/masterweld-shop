import copy, unittest
from gate import validate, CHECKS
class GateTests(unittest.TestCase):
    def setUp(self):
        self.sha="a"*40
        self.report={"mainSha":self.sha,"devSha":"b"*40,"ownerCommand":"обнови main","approvedAt":1000,"blockers":[],"checks":{x:{"passed":True,"evidence":"test evidence"} for x in CHECKS}}
    def test_valid(self): self.assertTrue(validate(self.report,self.sha,1001))
    def test_other_sha(self):
        with self.assertRaisesRegex(ValueError,"SHA_MISMATCH"): validate(self.report,"c"*40,1001)
    def test_stale(self):
        with self.assertRaisesRegex(ValueError,"EXPIRED"): validate(self.report,self.sha,90000)
    def test_future(self):
        with self.assertRaisesRegex(ValueError,"EXPIRED"): validate(self.report,self.sha,999)
    def test_blockers(self):
        self.report["blockers"]=["bot not connected"]
        with self.assertRaisesRegex(ValueError,"BLOCKERS"): validate(self.report,self.sha,1001)
    def test_every_check_requires_evidence(self):
        for name in CHECKS:
            r=copy.deepcopy(self.report); r["checks"][name]["evidence"]=""
            with self.subTest(name=name),self.assertRaises(ValueError): validate(r,self.sha,1001)
    def test_owner_command(self):
        self.report["ownerCommand"]=""
        with self.assertRaises(ValueError): validate(self.report,self.sha,1001)
if __name__=="__main__": unittest.main()
