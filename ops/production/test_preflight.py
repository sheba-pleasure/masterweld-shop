import unittest
from preflight import configuration_errors, DEV_ID, DEV_BOT
class PreflightTest(unittest.TestCase):
    def test_empty_fails(self):
        self.assertIn("MISSING:SUPABASE_SERVICE_ROLE_KEY",configuration_errors({},{}))
    def test_dev_identity_cannot_be_reused(self):
        errors=configuration_errors({"APP_ENV":"production","MW_INSTANCE_ID":DEV_ID,"TELEGRAM_BOT_ID":DEV_BOT,"ORDER_NOTIFICATIONS_ENABLED":"true"},{})
        self.assertIn("DEV_INSTANCE_FORBIDDEN",errors)
        self.assertIn("DEV_BOT_FORBIDDEN",errors)
        self.assertIn("PRODUCTION_ALERTS_NOT_REVIEWED",errors)
    def test_shared_key_denied(self):
        errors=configuration_errors({"SUPABASE_SERVICE_ROLE_KEY":"same"},{"SUPABASE_SERVICE_ROLE_KEY":"same"})
        self.assertIn("SHARED_DEV_SECRET:SUPABASE_SERVICE_ROLE_KEY",errors)
if __name__=="__main__": unittest.main()
