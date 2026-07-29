"""Keep the Python suite from silently going vacuous.

`assert` statements are stripped by the compiler under `python -O`, so a suite built on bare
asserts passes unconditionally there — every check gone, exit status 0. The suite therefore
asserts through unittest's assert* methods, which are ordinary calls. This test is the tripwire
that keeps it that way: it parses each test module's AST and rejects `assert` statements.

The second test is the direct proof: it re-runs a module under `-O` and checks that the same
number of tests actually execute.
"""
import ast
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TEST_FILES = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".py"))


class SuiteHygiene(unittest.TestCase):
    def test_there_are_test_modules_to_check(self):
        self.assertGreaterEqual(len(TEST_FILES), 5, TEST_FILES)

    def test_no_bare_assert_statements(self):
        offenders = []
        for name in TEST_FILES:
            with open(os.path.join(HERE, name)) as f:
                tree = ast.parse(f.read(), filename=name)
            for node in ast.walk(tree):
                if isinstance(node, ast.Assert):
                    offenders.append(f"{name}:{node.lineno}")
        self.assertEqual(
            offenders, [],
            "bare `assert` is compiled away under `python -O`, making these checks vacuous — "
            "use unittest's self.assert* methods instead: " + ", ".join(offenders))

    def test_assertions_still_run_under_dash_O(self):
        """A canary: unittest assertions must survive -O, and a bare assert must not."""
        canary = (
            "import unittest\n"
            "class T(unittest.TestCase):\n"
            "    def test_method_assert_runs(self):\n"
            "        try:\n"
            "            self.assertEqual(1, 2)\n"
            "        except AssertionError:\n"
            "            print('METHOD-ASSERT-RAN')\n"
            "    def test_bare_assert_is_stripped(self):\n"
            "        stripped = True\n"
            "        try:\n"
            "            assert False\n"
            "            print('BARE-ASSERT-STRIPPED')\n"
            "        except AssertionError:\n"
            "            pass\n"
            "unittest.main(argv=['x'], exit=False)\n"
        )
        proc = subprocess.run([sys.executable, "-O", "-c", canary],
                              capture_output=True, text=True, timeout=120)
        self.assertIn("METHOD-ASSERT-RAN", proc.stdout,
                      "unittest assertions did not run under -O")
        self.assertIn("BARE-ASSERT-STRIPPED", proc.stdout,
                      "expected -O to strip bare asserts; if it no longer does, this guard is moot")


if __name__ == "__main__":
    unittest.main()
