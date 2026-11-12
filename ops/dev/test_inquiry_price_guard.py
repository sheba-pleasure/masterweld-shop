"""DEV/production reject partial inquiry schema and incompatible immutable images."""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/production"))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


DEV = module("inquiry_dev_guard", ROOT / "ops/dev/app_compatibility.py")
PROD = module("inquiry_prod_guard", ROOT / "ops/production/app_compatibility.py")


class InquiryPriceGuardTests(unittest.TestCase):
    def test_every_partial_schema_is_rejected(self):
        for guard, error in [(DEV, RuntimeError), (PROD, ValueError)]:
            for mask in range(64):
                value = dict(identity=DEV.IDENTITY, sourceFacts=[True] * 6,
                             documentaryConditions=[True] * 6, accessoryDictionary=[True] * 4,
                             inquiryPrice=[bool(mask & (1 << i)) for i in range(6)])
                call = lambda: guard.validate_schema(value, DEV.IDENTITY) if guard is PROD else guard.validate_schema(value)
                if mask in (0, 63):
                    self.assertEqual(call(), guard.SCHEMA_0045_CAPABILITIES if mask else guard.SCHEMA_0043_CAPABILITIES)
                else:
                    with self.assertRaisesRegex(error, "INQUIRY_SCHEMA_INCOMPLETE"):
                        call()
            for bad in [None, [], [True] * 5, [1] * 6, "true"]:
                value["inquiryPrice"] = bad
                with self.assertRaisesRegex(error, "SCHEMA_INVALID"):
                    call()
            del value["inquiryPrice"]
            with self.assertRaisesRegex(error, "SCHEMA_INVALID"):
                call()

    def test_schema_requires_accessory_dependency(self):
        for guard, error in [(DEV, RuntimeError), (PROD, ValueError)]:
            value = dict(identity=DEV.IDENTITY, sourceFacts=[True] * 6,
                         documentaryConditions=[True] * 6, accessoryDictionary=[False] * 4,
                         inquiryPrice=[True] * 6)
            call = lambda: guard.validate_schema(value, DEV.IDENTITY) if guard is PROD else guard.validate_schema(value)
            with self.assertRaisesRegex(error, "INQUIRY_SCHEMA_INCOMPLETE"):
                call()
            value["accessoryDictionary"] = [True] * 4
            self.assertEqual(call(), guard.SCHEMA_0045_CAPABILITIES)

    def test_old_images_are_refused_even_for_empty_tables(self):
        for guard, error in [(DEV, RuntimeError), (PROD, ValueError)]:
            labels = {"org.opencontainers.image.revision": "a" * 40,
                      **{key: "1" for key in guard.SCHEMA_0043_CAPABILITIES}}
            if guard is DEV:
                labels["mw.environment"] = "dev"
            image = dict(Id="sha256:" + "b" * 64, Config=dict(Labels=labels))
            for bad in [None, "0", "true", 1]:
                if bad is not None:
                    labels[guard.INQUIRY_CAPABILITY] = bad
                with self.assertRaisesRegex(error, "IMAGE_INQUIRY_PRICE_UNSUPPORTED"):
                    guard.validate_image(image, "a" * 40, guard.SCHEMA_0045_CAPABILITIES)
            labels[guard.INQUIRY_CAPABILITY] = "1"
            self.assertEqual(guard.validate_image(image, "a" * 40, guard.SCHEMA_0045_CAPABILITIES), image["Id"])
            with self.assertRaisesRegex(error, "SCHEMA_REQUIREMENTS_INVALID"):
                guard.validate_image(image, "a" * 40, frozenset({guard.INQUIRY_CAPABILITY}))

    def test_same_read_only_probe(self):
        self.assertEqual(DEV.SCHEMA_SQL, PROD.SCHEMA_SQL)
        self.assertIn("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", DEV.SCHEMA_SQL)
        for marker in ["inquiry_price_version", "reject_inquiry_price_order", "INQUIRY"]:
            self.assertIn(marker, DEV.SCHEMA_SQL)


if __name__ == "__main__":
    unittest.main()
