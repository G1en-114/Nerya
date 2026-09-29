"""Repository CLI compatibility wrapper for the packaged demo runner."""
from nerya.security.mandate_demo import SCENARIOS, json_safe, main, run_demo, validate_request

if __name__ == "__main__":
    main()
