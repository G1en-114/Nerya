"""Repository CLI compatibility wrapper for the packaged dashboard exporter."""
from nerya.security.mandate_demo_export import TARGET, main, publish, snapshot

if __name__ == "__main__":
    main()
